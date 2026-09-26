#!/usr/bin/env bash
# Package a Linux/macOS build layout (scripts/build-unix.sh) into release archives:
#   dist/midnight.server-<platform>.tar.gz   (all platforms)
#   dist/midnight.server-linux-x64.deb       (linux-x64; installs to /opt/midnight.server)
#   dist/SHA256SUMS-<platform>               (merged into SHA256SUMS by the release workflow)
# The model is not included; it downloads on first use.
# Usage: scripts/package-unix.sh [version]   (version defaults to the git tag, e.g. v0.87.1-midnight.4)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
step() { echo "==> $*"; }

case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "Unsupported OS" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64 | amd64) arch=x64 ;; arm64 | aarch64) arch=arm64 ;; *) echo "Unsupported architecture" >&2; exit 1 ;; esac
platform="$os-$arch"
layout="${LAYOUT_DIR:-$repo_root/build/dist/midnight.server-$platform}"
[[ -f "$layout/release-manifest.json" ]] || { echo "Build output not found. Run scripts/build-unix.sh first." >&2; exit 1; }
version="${1:-$(git -C "$repo_root" describe --tags --exact-match 2>/dev/null || true)}"
version="${version#v}"
[[ -n "$version" ]] || version="$(node -p "require('$layout/package.json').version")"

dist="$repo_root/dist"
mkdir -p "$dist"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

tarball="$dist/midnight.server-$platform.tar.gz"
step "Creating $tarball"
cp -R "$layout" "$stage/midnight.server"
tar -C "$stage" -czf "$tarball" midnight.server
assets=("$tarball")

if [[ "$platform" == linux-x64 ]]; then
	deb="$dist/midnight.server-linux-x64.deb"
	step "Creating $deb"
	root="$stage/deb"
	mkdir -p "$root/opt" "$root/usr/bin" "$root/DEBIAN"
	cp -R "$layout" "$root/opt/midnight.server"
	# A wrapper, not a symlink: the executable finds its assets beside its own path.
	cat >"$root/usr/bin/midnight.server" <<'EOF'
#!/bin/sh
exec /opt/midnight.server/midnight.server "$@"
EOF
	chmod 0755 "$root/usr/bin/midnight.server"
	# Debian versions sort `+` after the base version: 0.87.1+midnight.4 > 0.87.1.
	deb_version="${version/-midnight./+midnight.}"
	cat >"$root/DEBIAN/control" <<EOF
Package: midnight.server
Version: $deb_version
Architecture: amd64
Maintainer: soliluqoy <soliluqoy@users.noreply.github.com>
Installed-Size: $(du -sk "$root/opt" | cut -f1)
Depends: libc6, libstdc++6, libgomp1
Section: devel
Priority: optional
Homepage: https://github.com/soliluqoy/midnight.server
Description: Coding agent CLI with a local MiniCPM model
 A terminal coding agent that works with cloud model providers and a local
 MiniCPM5-2B model served by a bundled llama.cpp engine. The model (2.5 GiB)
 downloads on first use into ~/.local/share/midnight.server.
EOF
	dpkg-deb --root-owner-group --build "$root" "$deb"
	assets+=("$deb")
fi

sums="$dist/SHA256SUMS-$platform"
: >"$sums"
for asset in "${assets[@]}"; do
	echo "$(sha256 "$asset")  $(basename "$asset")" >>"$sums"
done
cat "$sums"
