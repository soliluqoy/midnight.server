#!/bin/sh
# Download and install the latest midnight.server release from GitHub (Linux x64, macOS).
#
#     curl -fsSL https://raw.githubusercontent.com/soliluqoy/midnight.server/main/scripts/get.sh | sh
#
# Downloads midnight.server-<platform>.tar.gz from the newest GitHub release, verifies
# it against the release's SHA256SUMS, installs it into ~/.local/lib/midnight.server
# and puts a midnight.server launcher in ~/.local/bin. The model downloads on first use.
# scripts/get.ps1 is the Windows equivalent.
#
# Environment overrides:
#     MIDNIGHT_SERVER_VERSION      Release tag to install (default: newest release)
#     MIDNIGHT_SERVER_INSTALL_DIR  Install directory (default: ~/.local/lib/midnight.server)
#     MIDNIGHT_SERVER_BIN_DIR      Launcher directory (default: ~/.local/bin)
set -eu

repo="soliluqoy/midnight.server"
install_dir="${MIDNIGHT_SERVER_INSTALL_DIR:-$HOME/.local/lib/midnight.server}"
bin_dir="${MIDNIGHT_SERVER_BIN_DIR:-$HOME/.local/bin}"

fail() {
	echo "midnight.server: $*" >&2
	exit 1
}

case "$(uname -s)" in
	Linux) os=linux ;;
	Darwin) os=darwin ;;
	*) fail "unsupported OS $(uname -s). On Windows, use scripts/get.ps1." ;;
esac
case "$(uname -m)" in
	x86_64 | amd64) arch=x64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) fail "unsupported architecture $(uname -m)" ;;
esac
platform="$os-$arch"
case "$platform" in
	linux-x64 | darwin-x64 | darwin-arm64) ;;
	*) fail "no release build for $platform" ;;
esac

if [ -n "${MIDNIGHT_SERVER_VERSION:-}" ]; then
	base="https://github.com/$repo/releases/download/$MIDNIGHT_SERVER_VERSION"
else
	base="https://github.com/$repo/releases/latest/download"
fi

download() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 3 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
	else
		fail "curl or wget is required"
	fi
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

asset="midnight.server-$platform.tar.gz"
echo "Downloading $asset..."
download "$base/$asset" "$tmp/$asset" || fail "download failed: $base/$asset"
download "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"

expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "$asset is not listed in SHA256SUMS"
actual="$(sha256 "$tmp/$asset")"
[ "$actual" = "$expected" ] || fail "SHA-256 mismatch for $asset: expected $expected, got $actual"

mkdir -p "$tmp/extract"
tar -xzf "$tmp/$asset" -C "$tmp/extract"
[ -x "$tmp/extract/midnight.server/midnight.server" ] || fail "archive does not contain midnight.server"
if [ "$os" = darwin ]; then
	# Downloads made by a browser are quarantined; curl's are not, but clear it in case.
	xattr -dr com.apple.quarantine "$tmp/extract/midnight.server" 2>/dev/null || true
fi

mkdir -p "$(dirname "$install_dir")" "$bin_dir"
rm -rf "$install_dir.old"
[ -e "$install_dir" ] && mv "$install_dir" "$install_dir.old"
mv "$tmp/extract/midnight.server" "$install_dir"
rm -rf "$install_dir.old"

# A launcher, not a symlink: the executable finds its assets beside its own path.
cat >"$bin_dir/midnight.server" <<EOF
#!/bin/sh
exec "$install_dir/midnight.server" "\$@"
EOF
chmod 0755 "$bin_dir/midnight.server"

echo "Installed $("$install_dir/midnight.server" --version) to $install_dir"
case ":$PATH:" in
	*":$bin_dir:"*) echo "Run: midnight.server" ;;
	*)
		echo "Add $bin_dir to your PATH, for example:"
		echo "    echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.profile"
		echo "Then run: midnight.server"
		;;
esac
