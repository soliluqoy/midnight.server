# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read `AGENTS.md` first.** It holds the binding development rules (style, code quality, commands, git and PR workflow, no AI attribution, dependency security, changelog and versions). This file adds orientation and does not repeat those rules. Task playbooks live in `.midnight.server/`: `skills/release.md`, `skills/interactive-testing.md`, `skills/add-llm-provider.md`, and the prompts `cl` (changelog audit), `wr` (wrap up: changelog, commit, push, PR), `is` (issue analysis), `pr` (PR review), `deslop` (simplify). Read the matching file when doing that task.

## What this repo is

midnight.server is a coding CLI/TUI (Windows first, also Linux and macOS) built as a source derivative of the Pi monorepo (`@earendil-works/*` packages, still named that way). Its core is a lean, model-agnostic harness around Pi's tool loop, measured against plain Pi. `docs/WORKFLOW_PLAN.md` sets its defaults and how a feature earns a place; `docs/HARNESS_REBUILD_PLAN.md` holds the longer Luna-versus-Astra measurement plan; `README.md` describes user-facing behavior; `docs/IMPLEMENTATION_STATUS.md` records what is verified and known failing tests.

## Commands

- `npm run check`: biome (with `--write`), dependency/lockfile/shrinkwrap/import checks, `tsgo --noEmit`, browser smoke. Run after code changes.
- `./test.sh`: all non-e2e tests in an isolated HOME with no API keys.
- Single test, from the package root (e.g. `packages/coding-agent`):
  `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/harness-units.test.ts`
- `packages/tui` uses `node:test`: `node --test test/specific.test.ts`.
- Eval script tests: `node --test scripts/harness-eval-design.test.mjs scripts/harness-eval-stats.test.mjs`.
- Run from source: `.\pi-test.ps1 <args>` (PowerShell) or `./pi-test.sh` (Bash); `--no-env` strips provider API keys.
- Windows release build (PowerShell): `scripts\bootstrap.ps1 -Install`, `scripts\build.ps1`, `scripts\package.ps1`, `scripts\verify-release.ps1 -Package dist\midnight.server-windows-x64.zip`. `build.ps1` compiles the CLI with pinned Bun.
- Linux/macOS release build (Bash, host platform only): `bash scripts/build-unix.sh`, `bash scripts/package-unix.sh [tag]`, `node scripts/verify-release.mjs <tarball>`. Pushing a `v*-midnight.*` tag runs `.github/workflows/midnight-release.yml`: it builds and verifies Windows x64, Linux x64 and macOS arm64 and creates a draft release whose notes come from the tag's changelog section (`npm run release:notes -- <tag>`). Full steps: `.midnight.server/skills/release.md`.

Known baseline: on Windows, `./test.sh` has pre-existing non-midnight failures (config-dir rename `.pi` vs `.midnight.server`, `pi` vs `midnight.server` strings, Windows path/EPERM issues, unbuilt `dist/` exports). See `docs/IMPLEMENTATION_STATUS.md` before assuming a failure is yours.

## Architecture

Workspace packages build in dependency order: `chord` → `tui` → `telemetry` → `ai` → `durable` → `agent` → `session-backends/sqlite-node` → `protocol` → `client` → `server` → `coding-agent`. Cross-package imports resolve through package exports that point at `dist/`, so some tests fail until packages are built.

- `packages/ai`: provider APIs, model registry (`models.generated.ts` is generated), faux provider for tests.
- `packages/agent`: agent loop and session core.
- `packages/tui`: terminal UI library.
- `packages/coding-agent`: the product CLI. Almost all midnight-specific code lives here.

`packages/coding-agent/src/cli.ts` calls Pi's `main()`. Built-in extensions are registered in `src/extensions/index.ts`: `agent-mode` (plan/build tool swap), `harness`, and the session title extension (`src/midnight/session-title.ts`, names the session with the session model after the first exchange). `src/midnight/status.ts` is the shared plan/build mode store read by the sidebar, footer and `agent-mode`.

### `packages/coding-agent/src/harness/`

Model-agnostic built-in extension (`docs/harness.md`), deliberately lean: plain Pi is the baseline it must beat (`docs/WORKFLOW_PLAN.md`). `extension.ts` wires the parts: inline guards at each tool call (`parse-gate.ts`, `edit-repair.ts`, `interface-repair.ts`, protected files) and one verification pass at settle (`detect-checks.ts`/`checks.ts` for the check ladder, `baseline.ts` with `git.ts`'s `materializeTree` for pre-existing failures, `drift.ts` for the drift guard and blocker rule). `features.ts` holds the flags and defaults; opt-in features are `contextPack` (`workspace-index.ts`/`outline.ts`/`context-pack.ts`), `lookup` and `diagnostics` (`lsp.ts`/`semantic.ts`) and `escalation` (`escalate.ts`). Hook timings go to `telemetry.ts`. Project config is `.midnight.server/harness.json` and requires project trust. Product identity (`APP_NAME`, config dir `.midnight.server`) comes from `piConfig` in `packages/coding-agent/package.json` via `src/config.ts`.

### Evals

`scripts/harness-eval.mjs` runs tasks from `evals/harness/tasks/` (dev/holdout split, ablation variants via `MIDNIGHT_SERVER_HARNESS_FEATURES`, manifests via `scripts/harness-eval-design.mjs`, paired statistics in `scripts/harness-eval-stats.mjs`); `scripts/harness-eval-validate.mjs` checks the tasks without a model. `evals/drift/` holds the drift pilots and re-scoring scripts; `evals/sensitivity-lab/` analyzes factorial experiments. Escalation is off by default; an arm that switches it on is a cascade result, not the session model alone.

### Lattice-1

`packages/coding-agent/src/lattice/` implements the Lattice-1 pseudo-RSI harness spec (design, results and deviations in `docs/lattice/README.md`): a bounded typed IR run under fuel, kernel-owned contracts and evaluator, SQLite store with compare-and-swap promotion, rollback and an audit chain, improvement campaigns, library learning, synthesis and a level-2 policy loop. It is a standalone research tool, not part of a coding session: `npm run lattice -- <command>` (`selftest` for a quick end-to-end check); `sqlite.ts` lets the store run under Bun (`bun:sqlite`). Tests: `test/lattice-*.test.ts`.

### Tests

- Harness unit tests: `packages/coding-agent/test/harness-*.test.ts`; UI and config: `test/midnight-*.test.ts`.
- Session-level tests: `packages/coding-agent/test/suite/` with `harness.ts` and the faux provider (see `test/suite/README.md`); e.g. `harness.test.ts`, `harness-v2.test.ts`, `harness-drift.test.ts`.

## Platform notes

- Primary target is Windows x64; the default shell tool and `!`/`!!` commands use PowerShell on Windows. See `packages/coding-agent/docs/windows.md`.
- Released binaries: Windows x64, Linux x64 (`.deb`, tarball), macOS arm64 only, Apple Silicon (ad-hoc signed, not notarized). Windows CI on push/PR: `.github/workflows/midnight-windows.yml`; releases: `.github/workflows/midnight-release.yml`.
