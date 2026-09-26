#!/usr/bin/env bash
# Build the midnight.server Linux/macOS distribution layout (without the model) for
# the host platform. The Windows equivalent is scripts/build.ps1.
#
# 1. Compiles the CLI from TypeScript sources with the pinned Bun into one executable.
# 2. Copies runtime assets beside it, as Pi's release layout expects.
# 3. Installs the pinned, SHA-256-verified llama.cpp engine into engine/<backend>,
#    using the built CLI's own `engine fetch`.
# 4. Writes licenses and release-manifest.json (per-file SHA-256).
#
# Output: build/dist/midnight.server-<platform>/
# Requires: bun (the version in scripts/toolchain.lock.json), node, npm, git,
# and node_modules hydrated with `npm ci --ignore-scripts`.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agent="$repo_root/packages/coding-agent"
step() { echo "==> $*"; }

case "$(uname -s)" in
	Linux) os=linux ;;
	Darwin) os=darwin ;;
	*) echo "Unsupported OS: $(uname -s). Use scripts/build.ps1 on Windows." >&2; exit 1 ;;
esac
case "$(uname -m)" in
	x86_64 | amd64) arch=x64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
platform="$os-$arch"
# The backend every machine can run; `auto` may later pick a GPU build per user.
if [[ "$platform" == darwin-arm64 ]]; then backend=metal; else backend=cpu; fi
out="${OUT_DIR:-$repo_root/build/dist/midnight.server-$platform}"

want_bun="$(node -p "require('$repo_root/scripts/toolchain.lock.json').bun.version")"
have_bun="$(bun --version)"
if [[ "$have_bun" != "$want_bun" ]]; then
	echo "Bun $want_bun is required (found $have_bun)." >&2
	exit 1
fi

rm -rf "$out"
mkdir -p "$out"

step "Compiling midnight.server with Bun $have_bun for $platform"
bun_target="bun-$platform"
[[ "$arch" == x64 ]] && bun_target="$bun_target-baseline"
(
	cd "$repo_root"
	# Worker scripts are embedded only when passed as explicit entrypoints.
	# --no-compile-autoload-bunfig keeps a project's bunfig.toml from preloading into the binary.
	bun build --compile --no-compile-autoload-bunfig --target="$bun_target" \
		packages/coding-agent/src/bun/cli.ts packages/coding-agent/src/utils/image-resize-worker.ts \
		--outfile "$out/midnight.server"
)
if [[ "$os" == darwin ]]; then
	# Apple Silicon refuses to run unsigned code; an ad-hoc signature is enough for that.
	codesign --force --sign - "$out/midnight.server"
fi

step "Copying runtime assets"
cp "$agent/package.json" "$agent/README.md" "$agent/CHANGELOG.md" "$out/"
cp "$repo_root/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm" "$out/"
mkdir -p "$out/theme" "$out/export-html/vendor" "$out/native/$os/prebuilds"
cp "$agent"/src/modes/interactive/theme/*.json "$out/theme/"
cp "$agent"/src/core/export-html/template.* "$out/export-html/"
cp "$agent"/src/core/export-html/vendor/*.js "$out/export-html/vendor/"
cp -R "$repo_root/packages/tui/native/$os/prebuilds/$platform" "$out/native/$os/prebuilds/"
cp -R "$agent/docs" "$out/docs"

step "Installing bundled extensions"
# Pinned by packaging/extensions/package-lock.json; loaded by default from extensions/ beside the executable.
bundled="$repo_root/packaging/extensions"
npm ci --ignore-scripts --omit=peer --prefix "$bundled"
mkdir -p "$out/extensions"
cp "$bundled/package.json" "$out/extensions/"
cp -R "$bundled/node_modules" "$out/extensions/"
# pi-mcp-adapter only calls recheck's checkSync, which runs in JS; the native and Java
# agents back the async check() and are never loaded.
rm -rf "$out/extensions/node_modules/.bin" "$out/extensions/node_modules"/recheck-*

step "Installing engine ($backend)"
# The built CLI downloads, verifies and unpacks its own pinned engine, so the bundled
# copy is laid out (and marked) exactly like a first-run download.
# .cache/engine-home keeps it between builds.
fetched="$(MIDNIGHT_SERVER_HOME="$repo_root/.cache/engine-home" "$out/midnight.server" engine fetch "$backend" 2>&1)" || {
	echo "$fetched" >&2
	exit 1
}
engine_root="$(printf '%s\n' "$fetched" | sed -n 's/^Engine installed: //p' | tail -n 1)"
if [[ -z "$engine_root" ]]; then
	echo "engine fetch did not report an install directory:" >&2
	echo "$fetched" >&2
	exit 1
fi
mkdir -p "$out/engine"
cp -R "$engine_root" "$out/engine/$backend"
server="$(node -p "require('$out/engine/$backend/.midnight-engine.json').server")"
[[ -x "$out/engine/$backend/$server" ]] || { echo "Bundled engine is missing $server" >&2; exit 1; }

step "Writing licenses and notices"
mkdir -p "$out/licenses" "$out/models"
cp "$repo_root/LICENSE" "$out/licenses/pi-LICENSE.txt"
cp "$repo_root"/packaging/licenses/* "$out/licenses/"
cp "$repo_root/packaging/THIRD_PARTY_NOTICES.md" "$out/"
cp "$repo_root/models/minicpm5-2b-q8_0.lock.json" "$out/models/model-manifest.json"

step "Writing release-manifest.json"
node "$repo_root/scripts/write-release-manifest.mjs" "$out" "$platform" "$backend" "$out/engine/$backend"

echo ""
echo "Built $out ($(du -sh "$out" | cut -f1), without model)"
