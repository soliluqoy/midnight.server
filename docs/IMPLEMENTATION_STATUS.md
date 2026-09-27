# Implementation status

Updated 2026-09-27. The plan is [HARNESS_REBUILD_PLAN.md](HARNESS_REBUILD_PLAN.md). This page records what midnight.server changes in Pi, what is verified, and known test failures.

## What midnight.server adds to Pi

| Area | Where | Status |
| --- | --- | --- |
| Harness (context pack, syntax gate, edit repair, `lookup`, language-server errors, check ladder, rollback, drift guard, blocker rule, escalation, masking) | `packages/coding-agent/src/harness/`, [docs](../packages/coding-agent/docs/harness.md) | Unit and suite tests pass. Measured only on short tasks (`evals/harness/RESULTS.md`, `evals/drift/RESULTS.md`); the Luna-Astra gap on hard tasks is not measured. |
| Plan/build modes, sidebar, footer badge | `src/extensions/agent-mode.ts`, `src/midnight/status.ts`, `src/modes/interactive/components/` | Tests pass. |
| Session titles from the session model | `src/midnight/session-title.ts` | Tests pass. |
| Side threads (`/ask`, Alt+T) | `src/core/side-threads.ts`, `src/modes/interactive/side-thread-controller.ts` | Tests pass. |
| Product identity (`midnight.server`, config dir `.midnight.server`, `MIDNIGHT_SERVER_*` variables) | `piConfig` in `packages/coding-agent/package.json`, `src/config.ts` | Partial; see known failures. |
| Windows build and release | `scripts/bootstrap.ps1`, `build.ps1`, `package.ps1`, `verify-release.ps1`, `.github/workflows/midnight-windows.yml` | Scripts parse; not re-run since the local model was removed. |
| Linux/macOS build and release | `scripts/build-unix.sh`, `package-unix.sh`, `verify-release.mjs`, `.github/workflows/midnight-release.yml` | Not re-run since the local model was removed. |
| Eval runner and analysis | `scripts/harness-eval*.mjs`, `evals/` | Script unit tests pass. |

## Removed (2026-09-27)

The local MiniCPM5-2B model and everything built for it: `--local` and `--hybrid`, `delegate_local` and helper tasks, drift watch, the llama.cpp engine, its pins and download, `native/midnight-host`, the model lock, the `model`/`engine`/`doctor`/`helper` subcommands, the built-in llama.cpp provider, and the offline release. Also the harness's `task` contract, the Laya review, and the local-model profile. Reasons are in [the plan](HARNESS_REBUILD_PLAN.md#4-what-this-rebuild-removed). The measurements that informed it stay in `evals/harness/RESULTS.md` and `evals/drift/RESULTS.md`.

## Upstream base

The Pi source snapshot is `earendil-works/pi` v0.87.1 (`f07218c4d`, recorded in `docs/upstreams.lock.json`), ported on 2026-09-26 from 0.85.1+147 (`36b60d2e`). How the port was done, so the next one can repeat it:

1. `git diff -M 36b60d2e v0.87.1 | git apply -3` with the upstream objects fetched locally. Source conflicts were limited to imports and the `ENV_RADIUS_GATEWAY` move.
2. Documentation was merged three ways against rebranded inputs (ours, `rebrand(base)`, `rebrand(upstream)`), so only real edits conflict. The rebrand is mechanical: `PI_*` becomes `MIDNIGHT_SERVER_*`, `~/.pi` and `.pi/` become `.midnight.server`, and prose `Pi`/`pi` becomes `midnight.server`; TypeScript, JavaScript, Python and JSON code blocks keep `pi` identifiers and the `"pi"` package manifest key. The package README stays ours; upstream reduced its copy to a pointer page.
3. New upstream source was checked for `PI_*` variables and user-facing "Pi" strings. `PI_CACHE_RETENTION` and `PI_RADIUS_GATEWAY` became `MIDNIGHT_SERVER_*`.
4. `/bug` is export-only: upstream uploads reports to the Pi developers' Radius service.
5. Changelogs keep our Unreleased entries, drop upstream entries that were released since the base, and insert upstream's released sections.

## Not done

1. **The measurement in the plan's Step 0 and Step 1**: a fresh holdout of longer multi-file tasks, per-run process isolation, escalation cost and per-phase timing in the run receipt, and the four-arm Luna/Astra comparison.
2. **Product identity leftovers.** Package scopes remain `@earendil-works/*`; many docs, help text and the built-in update checker still refer to Pi.
3. **Release infrastructure.** No Authenticode signing, update/rollback flow, SBOM, or clean-VM run.

## Known test status

`npm run check` passes. The midnight and harness tests pass.

Package tests under `test.sh`'s isolated environment on Windows have failures that do not involve midnight code:

- `coding-agent`: causes seen are the config-directory rename (tests write project settings to `.pi/` while the product reads `.midnight.server/`), tests that pass raw `C:\` paths to `node --import` (Node rejects them on Windows), `pi` vs `midnight.server` strings in expected help text, Windows EPERM vs EACCES, and Git Bash path translation.
- `agent-core`, `durable`, `session-backends/sqlite-node`, `client`, `server`: many files fail to load because package exports point at `dist/`, which is not built (the repository rules forbid `npm run build` without a request).

Fixing these is part of finishing the rename and Windows test portability.
