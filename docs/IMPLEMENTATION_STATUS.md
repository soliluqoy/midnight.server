# Implementation status

Updated 2026-09-26. Tracks [the plan](../IMPLEMENTATION_PLAN.md). Everything below was verified on **one** machine (Windows 10 Pro 19045, i7-8650U, 15.9 GiB, CPU only) unless marked otherwise. This is not a release qualification.

## Working and verified

| Plan item | What exists | Evidence |
| --- | --- | --- |
| Engine lifecycle (Phase 3.1, 4.3) | `src/midnight/engine.ts`: loopback-only `llama-server`, random port, per-session 256-bit key passed via a short-lived key file (never argv), readiness wait, startup timeout, retry on early exit, **fail-closed check that an unauthenticated request gets 401**, minimal child environment (no provider credentials) | `test/midnight-engine.integration.test.ts` (real model): 401 without/with wrong key, key file deleted, cancel then recover, no leftover process |
| Process ownership (4.3) | `native/midnight-host` (C#, in-box `csc`): Job Object with `KILL_ON_JOB_CLOSE`, host exits when the CLI's stdin pipe closes | Manual test: exit code and argv quoting preserved; descendants killed on stdin close and on forced host kill |
| Model store (3.2) | `store.ts`, `download.ts`: bundled / per-user / override lookup, resumable download with byte limit and SHA-256 check before atomic rename, stale-lock takeover, per-file verification cache | `test/midnight-download.test.ts`, `midnight-model-integrity.test.ts` |
| Automatic first-run fetch | `engine-manager.ts`'s `resolveModel()`/`resolveEngine()`: download the model and the selected engine build the first time either is missing, instead of erroring; an explicit `MIDNIGHT_SERVER_MODEL`/`MIDNIGHT_SERVER_ENGINE_DIR` override that points at nothing still fails closed rather than being routed around | `test/midnight-engine-manager.test.ts` |
| Engine download | `engine fetch [backend]`: every official `b11166` build for 6 platforms (21 builds, 29 archives, `engine-builds.generated.ts`), SHA-256 per archive, archives merged into one directory, other llama.cpp tools removed, a marker naming the pinned build written last | `test/midnight-engine-store.test.ts`; Windows CPU and Vulkan, and Linux CPU and Vulkan (WSL Ubuntu 26.04) downloaded and started |
| Backend selection | `backend.ts`: `auto` lists GPUs with the Vulkan (Metal on Apple Silicon) build, runs the model on GPU and CPU, keeps the GPU only if a typical task is 10% faster; saved per engine release; automatic GPU choices fall back to the CPU if they stop starting | `test/midnight-backend.test.ts`, `midnight-engine-fallback.test.ts`; real probe on the i7-8650U kept the CPU (UHD 620: 167 s vs 96 s per typical task); `engine use vulkan` + `doctor --smoke` generated on the GPU; WSL (no GPU) chose the CPU and generated. CUDA, ROCm, SYCL, OpenVINO, Metal, OpenCL and Hexagon builds are pinned but not run |
| Local provider (3.3) and `--local` (4.1) | `extension.ts` registers provider `midnight` / `minicpm5-2b-q8_0` (openai-completions, `enable_thinking` mapping); `--local` forces `--offline`, selects only that model, and `ModelRuntime.restrictRequestProviders()` blocks every other provider for the session | Unit test for the allowlist; `--local -p` answered correctly through a `read` tool call (77 s) and through the compiled exe with a `powershell` tool call (95 s) |
| Diagnostics (3.4) | `model status/verify/fetch`, `engine status/fetch`, `doctor [--smoke]` | Run from source and from the packaged exe |
| Helper contract (4.1-4.5) | `helper.ts`: typed task/result, kinds summarize/classify/inspect/plan/patch, workspace confinement via realpath (traversal, junctions, other drives, case), byte budget with truncation flag, input SHA-256 refs, JSON-schema constrained output, one repair attempt, evidence validation, deadline and cancellation, serialized engine queue. Patch tasks return exact-match edits rendered as an unapplied unified diff (CRLF-aware) | `test/midnight-helper.test.ts` (21 cases), integration test with the real model |
| `delegate_local` and `helper` (4.2) | Hybrid mode tool (engine starts lazily, idle stop) and the direct `helper` CLI command | `test/suite/midnight-delegate.test.ts` (faux parent model); `helper inspect` run with the real model |
| Windows shell (Phase 2.4-2.5) | Windows default tools use `powershell`; `!`/`!!` use PowerShell unless `shellPath` is set | Unit tests; compiled exe run with a PATH containing no Git Bash |
| Build and packaging (Phase 6) | `scripts/bootstrap.ps1`, `build.ps1`, `fetch-model.ps1`, `package.ps1`, `verify-release.ps1`, `packaging/join-offline.ps1`; pinned Bun 1.3.14; per-file SHA-256 `release-manifest.json`; licenses and notices | Both archives built; offline archive split to 1,900 + 714 MiB parts and reassembled to the published hash; `verify-release.ps1 -Smoke` passed from a path with spaces and `ü`, minimal PATH, isolated state |
| Provenance | `docs/upstreams.lock.json`, `src/midnight/engine-builds.generated.ts` (from `scripts/generate-engine-pins.mjs`), `models/*.lock.json`, `scripts/toolchain.lock.json` | Pins test keeps the compiled model pin equal to its JSON lock |
| Measurements | `docs/benchmarks/cpu-i7-8650u.md` | Thread scaling, start times, helper latency, memory |

Bugs found and fixed by these checks: the engine ignored the API key when passed through an environment variable (llama-server has none), and it could not open its key file under a non-ASCII path (ANSI file API).

## Upstream base

The Pi source snapshot is `earendil-works/pi` v0.87.1 (`f07218c4d`, recorded in `docs/upstreams.lock.json`), ported on 2026-09-26 from 0.85.1+147 (`36b60d2e`). How the port was done, so the next one can repeat it:

1. `git diff -M 36b60d2e v0.87.1 | git apply -3` with the upstream objects fetched locally. Source conflicts were limited to imports and the `ENV_RADIUS_GATEWAY` move.
2. Documentation was merged three ways against rebranded inputs (ours, `rebrand(base)`, `rebrand(upstream)`), so only real edits conflict. The rebrand is mechanical: `PI_*` becomes `MIDNIGHT_SERVER_*`, `~/.pi` and `.pi/` become `.midnight.server`, and prose `Pi`/`pi` becomes `midnight.server`; TypeScript, JavaScript, Python and JSON code blocks keep `pi` identifiers and the `"pi"` package manifest key. The package README stays ours; upstream reduced its copy to a pointer page.
3. New upstream source was checked for `PI_*` variables and user-facing "Pi" strings. `PI_CACHE_RETENTION` and `PI_RADIUS_GATEWAY` became `MIDNIGHT_SERVER_*`.
4. `/bug` is export-only: upstream uploads reports to the Pi developers' Radius service.
5. Changelogs keep our Unreleased entries, drop upstream entries that were released since the base, and insert upstream's released sections.

0.87.0 API changes checked against midnight code: `shouldStopAfterTurn` (unused), `context` handlers no longer receiving system messages (drift watch only reads the conversation), actionable `turn_end` and `agent_before_settle` boundaries (drift watch and session titles only observe), canonical `SessionManager` context (no midnight code assigns `agent.state.messages`), `ContextEditEntry` in `SessionEntry` (typechecks), and non-strict tools for unknown OpenAI-compatible endpoints (the local provider already sets `supportsStrictMode: false`). The bundled `pi-mcp-adapter` 2.37.0 is built against 0.87.0.

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

Package tests under `test.sh`'s isolated environment on this Windows machine still have failures that do not involve midnight code. After the 0.87.1 port (2026-09-26), every package suite was run on both the pre-port tree and the ported tree: no test fails only after the port, and six pre-port failures are fixed by upstream. Upstream tests that encode Pi defaults were adapted: the `MIDNIGHT_SERVER_CACHE_RETENTION` name, the product name in the crash hint, and the Windows `powershell` default tool in the #9789 regression.

- `coding-agent`: 125 of 2,601 tests fail. Causes seen: the earlier config-directory rename (tests write project settings to `.pi/` while the product reads `.midnight.server/`), tests that pass raw `C:\` paths to `node --import` (Node rejects them on Windows), `pi` vs `midnight.server` strings in expected help text, Windows EPERM vs EACCES, and Git Bash path translation.
- `agent-core`, `durable`, `session-backends/sqlite-node`, `client`, `server`: many files fail to load because package exports point at `dist/`, which is not built (the repository rules forbid `npm run build` without a request). Run through a vitest config that resolves workspace packages to their `source` export (as `vitest.base.ts` does), `agent-core` runs 875 tests with 51 failures, all Windows symlink EPERM and JSONL v3 legacy migration, identical before and after the port; `durable` passes 77 of 77.
- `scripts/coding-agent-consumer.test.mjs` spawns `C:\Program Files\nodejs\node.exe` through a shell without quoting, which stops `npm test` before the package tests.

Fixing these is part of finishing the Phase 2 rename and Windows test portability.
