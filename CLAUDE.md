# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read `AGENTS.md` first.** It holds the binding development rules (style, code quality, commands, git safety for concurrent sessions, dependency security, changelog). This file adds orientation and does not repeat those rules. Never add Claude attribution (`Co-Authored-By` trailers, "Generated with Claude Code" footers) to commits or PRs.

## What this repo is

midnight.server is a native Windows coding CLI/TUI built as a source derivative of the Pi monorepo (`@earendil-works/*` packages, still named that way). It adds a local MiniCPM5-2B Q8_0 model served by a SHA-256-pinned prebuilt llama.cpp `llama-server`. The cloud provider leads; the local model does delegated read-only jobs (`delegate_local`) and background drift checks. `README.md` describes user-facing behavior; `docs/IMPLEMENTATION_STATUS.md` records what is verified, deviations from `IMPLEMENTATION_PLAN.md`, and known failing tests.

## Commands

- `npm run check`: biome (with `--write`), dependency/lockfile/shrinkwrap/import checks, `tsgo --noEmit`, browser smoke. Run after code changes.
- `./test.sh`: all non-e2e tests in an isolated HOME with no API keys (`PI_NO_LOCAL_LLM=1`).
- Single test, from the package root (e.g. `packages/coding-agent`):
  `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/midnight-helper.test.ts`
- `packages/tui` uses `node:test`: `node --test test/specific.test.ts`.
- Real-model engine test: `test/midnight-engine.integration.test.ts` runs only with `MIDNIGHT_SERVER_ENGINE_TESTS=1` and an installed model/engine.
- Run from source: `.\pi-test.ps1 <args>` (PowerShell) or `./pi-test.sh` (Bash); `--no-env` strips provider API keys.
- Windows release build (PowerShell): `scripts\bootstrap.ps1 -Install`, `scripts\build.ps1`, `scripts\fetch-model.ps1`, `scripts\package.ps1 -IncludeModel`, `scripts\verify-release.ps1`. `build.ps1` compiles the CLI with pinned Bun and `native\midnight-host` with the in-box C# compiler.
- Linux/macOS release build (Bash, host platform only): `bash scripts/build-unix.sh`, `bash scripts/package-unix.sh [tag]`, `node scripts/verify-release.mjs <tarball> [--smoke]`. Pushing a `v*-midnight.*` tag runs `.github/workflows/midnight-release.yml`: it builds and verifies Windows x64, Linux x64 and macOS arm64/x64 and attaches everything to a draft release.
- Re-pin engine builds: `node scripts/generate-engine-pins.mjs <llama.cpp tag>` (writes `src/midnight/engine-builds.generated.ts`; do not hand-edit it).

Known baseline: on Windows, `./test.sh` has pre-existing non-midnight failures (config-dir rename `.pi` vs `.midnight.server`, `pi` vs `midnight.server` strings, Windows path/EPERM issues, unbuilt `dist/` exports). See `docs/IMPLEMENTATION_STATUS.md` before assuming a failure is yours.

## Architecture

Workspace packages build in dependency order: `chord` → `tui` → `telemetry` → `ai` → `durable` → `agent` → `session-backends/sqlite-node` → `protocol` → `client` → `server` → `coding-agent`. Cross-package imports resolve through package exports that point at `dist/`, so some tests fail until packages are built.

- `packages/ai`: provider APIs, model registry (`models.generated.ts` is generated), faux provider for tests.
- `packages/agent`: agent loop and session core.
- `packages/tui`: terminal UI library.
- `packages/coding-agent`: the product CLI. Almost all midnight-specific code lives here.

### Startup flow (`packages/coding-agent/src/cli.ts`)

1. `midnight/commands.ts` `runMidnightCommand` handles subcommands that never start a session (`helper`, `model`, `engine`, `doctor`) and returns an exit code.
2. Otherwise `midnight/local-runtime.ts` `prepareLocalRuntime` parses the mode (`default`/`hybrid`/`local`) and returns rewritten args plus extension factories. `--local` starts the engine, forces offline, and uses `ModelRuntime.restrictRequestProviders()` to block every other provider. Default/hybrid keeps the configured provider and adds `delegate_local` and drift watch; with no provider configured it silently falls back to the local model. Non-session invocations (`--version`, `--help`) must not start or download the engine.
3. Pi's `main()` runs the session with those extension factories.

### `packages/coding-agent/src/midnight/`

The local-model integration is kept in this directory (not separate packages) to avoid lockfile/shrinkwrap churn.

- `pins.ts`, `engine-builds.generated.ts`, `models/*.lock.json`, `docs/upstreams.lock.json`: pinned model and engine identities. A test keeps the compiled model pin equal to its JSON lock.
- `store.ts`, `download.ts`, `model-integrity.ts`, `paths.ts`: locate bundled / per-user (`MIDNIGHT_SERVER_HOME`) / override artifacts; resumable, SHA-256-verified downloads with atomic rename. Explicit overrides that point at nothing fail closed.
- `engine.ts`: one `llama-server` on loopback with a random port and a per-session key passed through a key file (never argv or env). On Windows it runs under `native/midnight-host`, which owns a Job Object that kills the engine tree when the CLI exits; on Linux/macOS it runs under the `POSIX_HOST` `/bin/sh` wrapper, which kills it when the stdin ownership pipe closes.
- `engine-manager.ts`: lazy start, idle stop, and first-use fetch of model and engine. `backend.ts`: `auto` GPU vs CPU probe, saved per engine release, with CPU fallback.
- `extension.ts`: registers provider `midnight` / model `minicpm5-2b-q8_0` (openai-completions) and the `delegate_local` tool.
- `helper.ts`: typed helper tasks (summarize/classify/inspect/plan/patch), workspace confinement via realpath, byte budget (~6 KB), schema-constrained output with one repair, evidence validation, fixed-argv read-only git ops. Patches are exact `oldText`/`newText` edits rendered as an unapplied diff.
- `drift-watch.ts`: background local-model checks in cloud-led sessions. `session-title.ts`: names the session with the session model after the first exchange.
- `status.ts`: shared status store read by the UI (sidebar, footer) and `extensions/agent-mode.ts` (plan/build mode tool swap).

Built-in extensions are registered in `src/extensions/index.ts` (`llama.cpp` server provider, `agent-mode`). Product identity (`APP_NAME`, config dir `.midnight.server`) comes from `piConfig` in `packages/coding-agent/package.json` via `src/config.ts`.

### Tests

- Midnight unit tests: `packages/coding-agent/test/midnight-*.test.ts`.
- Session-level tests: `packages/coding-agent/test/suite/` with `harness.ts` and the faux provider (see `test/suite/README.md`); e.g. `midnight-delegate.test.ts`, `midnight-drift-watch.test.ts`.

## Platform notes

- Primary target is Windows x64; the default shell tool and `!`/`!!` commands use PowerShell on Windows. See `packages/coding-agent/docs/windows.md`.
- Released binaries: Windows x64, Linux x64 (`.deb`, tarball), macOS arm64/x64 (ad-hoc signed, not notarized). Windows CI on push/PR: `.github/workflows/midnight-windows.yml`; releases: `.github/workflows/midnight-release.yml`.
- Interactive-mode testing with tmux: `.pi/skills/interactive-testing.md`. Release process: `.pi/skills/release.md`.
