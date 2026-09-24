# Implementation status

Updated 2026-09-25. Tracks [the plan](../IMPLEMENTATION_PLAN.md). Everything below was verified on **one** machine (Windows 10 Pro 19045, i7-8650U, 15.9 GiB, CPU only) unless marked otherwise. This is not a release qualification.

## Working and verified

| Plan item | What exists | Evidence |
| --- | --- | --- |
| Engine lifecycle (Phase 3.1, 4.3) | `src/midnight/engine.ts`: loopback-only `llama-server`, random port, per-session 256-bit key passed via a short-lived key file (never argv), readiness wait, startup timeout, retry on early exit, **fail-closed check that an unauthenticated request gets 401**, minimal child environment (no provider credentials) | `test/midnight-engine.integration.test.ts` (real model): 401 without/with wrong key, key file deleted, cancel then recover, no leftover process |
| Process ownership (4.3) | `native/midnight-host` (C#, in-box `csc`): Job Object with `KILL_ON_JOB_CLOSE`, host exits when the CLI's stdin pipe closes | Manual test: exit code and argv quoting preserved; descendants killed on stdin close and on forced host kill |
| Model store (3.2) | `store.ts`, `download.ts`: bundled / per-user / override lookup, resumable download with byte limit and SHA-256 check before atomic rename, stale-lock takeover, per-file verification cache | `test/midnight-download.test.ts`, `midnight-model-integrity.test.ts` |
| Engine download | `engine fetch`: pinned `b11166` zip, SHA-256, extracts only the 23 runtime files | Ran against GitHub; engine then started from the extracted set |
| Local provider (3.3) and `--local` (4.1) | `extension.ts` registers provider `midnight` / `minicpm5-2b-q8_0` (openai-completions, `enable_thinking` mapping); `--local` forces `--offline`, selects only that model, and `ModelRuntime.restrictRequestProviders()` blocks every other provider for the session | Unit test for the allowlist; `--local -p` answered correctly through a `read` tool call (77 s) and through the compiled exe with a `powershell` tool call (95 s) |
| Diagnostics (3.4) | `model status/verify/fetch`, `engine status/fetch`, `doctor [--smoke]` | Run from source and from the packaged exe |
| Helper contract (4.1-4.5) | `helper.ts`: typed task/result, kinds summarize/classify/inspect/plan/patch, workspace confinement via realpath (traversal, junctions, other drives, case), byte budget with truncation flag, input SHA-256 refs, JSON-schema constrained output, one repair attempt, evidence validation, deadline and cancellation, serialized engine queue. Patch tasks return exact-match edits rendered as an unapplied unified diff (CRLF-aware) | `test/midnight-helper.test.ts` (21 cases), integration test with the real model |
| `delegate_local` and `helper` (4.2) | Hybrid mode tool (engine starts lazily, idle stop) and the direct `helper` CLI command | `test/suite/midnight-delegate.test.ts` (faux parent model); `helper inspect` run with the real model |
| Windows shell (Phase 2.4-2.5) | Windows default tools use `powershell`; `!`/`!!` use PowerShell unless `shellPath` is set | Unit tests; compiled exe run with a PATH containing no Git Bash |
| Build and packaging (Phase 6) | `scripts/bootstrap.ps1`, `build.ps1`, `fetch-model.ps1`, `package.ps1`, `verify-release.ps1`, `packaging/join-offline.ps1`; pinned Bun 1.3.14; per-file SHA-256 `release-manifest.json`; licenses and notices | Both archives built; offline archive split to 1,900 + 714 MiB parts and reassembled to the published hash; `verify-release.ps1 -Smoke` passed from a path with spaces and `ü`, minimal PATH, isolated state |
| Provenance | `docs/upstreams.lock.json`, `engine/*.lock.json`, `models/*.lock.json`, `scripts/toolchain.lock.json` | Pins test keeps compiled pins equal to JSON locks |
| Measurements | `docs/benchmarks/cpu-i7-8650u.md` | Thread scaling, start times, helper latency, memory |

Bugs found and fixed by these checks: the engine ignored the API key when passed through an environment variable (llama-server has none), and it could not open its key file under a non-ASCII path (ANSI file API).

## Deviations from the plan

- **Engine is the official prebuilt release, not a vendored source build.** It is pinned by SHA-256 and commit. Building from source needs Visual Studio Build Tools and CMake, which were not installed; `vendor/llama.cpp` does not exist.
- **Default context is 8K, not 4K**: Pi's agent prompt needs the room; measured cost is ~170 MiB.
- **Helper input budget 6 KB** (about one minute of prompt processing on this CPU) after a 12 KB task took 181 s and was answered wrongly.
- **Patch format**: the helper proposes exact `oldText`/`newText` edits instead of writing unified diffs, because a 2B model cannot reliably produce hunk headers. The tool renders the diff.
- **No `packages/midnight-runtime` / `midnight-orchestrator` packages**: the code lives in `packages/coding-agent/src/midnight/` to avoid new workspace packages, lockfile and shrinkwrap changes.

## Not done

1. **Quality evaluation (Phase 5.3-5.5).** No corpus of 50+ representative jobs, no schema-valid or rubric pass rates, no Q8 vs higher-precision comparison. One observed failure is recorded in the benchmark notes. Default thinking on/off per task kind is a guess from one sample.
2. **Local coordinator mode (4.1, 5.1-5.2).** MiniCPM does not propose task plans that a scheduler validates and dispatches; hybrid escalation policy settings do not exist. `plan` tasks only return text.
3. **Patch isolation beyond proposals (4.5).** No git worktree mode, no helper-run checks or tests, no stale-file check at apply time (inputs are hashed so a parent can compare).
4. **Persistent helper task records and UI (4.1, 4.7).** Results go to the tool result and patch artifacts only; there is no task log, resumable task state, or TUI status panel.
5. **llama.cpp source build, GPU backends (Vulkan/CUDA), ARM64.** The target machine has only an Intel UHD 620.
6. **SGLang comparison.** Not attempted (no NVIDIA GPU available).
7. **Tool protocol matrix (4.4).** Tool calls worked through llama.cpp's native MiniCPM handling in all runs, but there are no golden tests for template history, duplicate calls, CDATA or streaming fragments.
8. **Product identity leftovers (Phase 2).** Package scopes remain `@earendil-works/*`; many docs, help text and the built-in update checker still refer to Pi; no versioned midnight config schema or Pi config import.
9. **Release infrastructure (Phase 6.6, 7).** No Authenticode signing, update/rollback flow, SBOM, clean-VM run, or published release. The CI workflow `.github/workflows/midnight-windows.yml` has **not been run**.

## Known test status

`npm run check` passes. All midnight tests pass, including the real-model integration test. Three existing tests that assumed Bash as the Windows default tool were updated.

Package tests under `test.sh`'s isolated environment on this Windows machine (2026-09-25) still have failures that do not involve midnight code:

- `coding-agent`: 131 of 2,397 tests fail in 35 files. Causes seen: the earlier config-directory rename (tests write project settings to `.pi/` while the product reads `.midnight.server/`), tests that pass raw `C:\` paths to `node --import` (Node rejects them on Windows), `pi` vs `midnight.server` strings in expected help text, Windows EPERM vs EACCES, and Git Bash path translation.
- `agent-core`: 61 files fail on `@earendil-works/pi-ai/utils/uuid` resolution because package exports point at `dist/`, which is not built (the repository rules forbid `npm run build` without a request).
- `scripts/coding-agent-consumer.test.mjs` spawns `C:\Program Files\nodejs\node.exe` through a shell without quoting, which stops `npm test` before the package tests.

Fixing these is part of finishing the Phase 2 rename and Windows test portability.
