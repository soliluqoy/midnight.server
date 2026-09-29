# Implementation status

Updated 2026-09-28. This page records what midnight.server changes in Pi, what is verified, and known test failures.

## What midnight.server adds to Pi

| Area | Where | Status |
| --- | --- | --- |
| Harness (inline guards: syntax gate, edit, path and shell repairs, protected files; one check pass at settle with a lazy baseline for pre-existing failures, one repair round, drift guard, blocker rule; opt-in escalation) | `packages/coding-agent/src/harness/`, [docs](../packages/coding-agent/docs/harness.md) | Unit and suite tests pass. Not measured against plain Pi on larger repositories. |
| Plan/build modes, sidebar, footer badge | `src/extensions/agent-mode.ts`, `src/midnight/status.ts`, `src/modes/interactive/components/` | Tests pass. |
| Session titles from the session model | `src/midnight/session-title.ts` | Tests pass. |
| Side threads (`/ask`, Alt+T) | `src/core/side-threads.ts`, `src/modes/interactive/side-thread-controller.ts` | Tests pass. |
| Product identity (`midnight.server`, config dir `.midnight.server`, `MIDNIGHT_SERVER_*` variables) | `piConfig` in `packages/coding-agent/package.json`, `src/config.ts` | Partial; see known failures. |
| Windows build and release | `scripts/bootstrap.ps1`, `build.ps1`, `package.ps1`, `verify-release.ps1`, `.github/workflows/midnight-windows.yml` | Scripts parse; not re-run since the local model was removed. |
| Linux/macOS build and release | `scripts/build-unix.sh`, `package-unix.sh`, `verify-release.mjs`, `.github/workflows/midnight-release.yml` | Not re-run since the local model was removed. |

## Removed (2026-09-28)

- Lattice-1 (the standalone pseudo-RSI kernel, `npm run lattice`) and its docs and tests. Nothing in a session used it.
- From the harness: the context pack and workspace index, the `lookup` tool, the language-server client and per-edit diagnostics; earlier the same day observation masking (it invalidated the prompt cache), mid-run checks, checkpoint rollback, divergence feedback, the reasoning boost, the verifier probe, loop-triggered escalation, the fast/frontier model classes and the Lattice-1 policy loop. None had a measured gain over plain Pi.
- The research and eval material: the rebuild and Luna design plans, `docs/premise`, `evals/` and the `scripts/harness-eval*` runner.

## Removed (2026-09-27)

The local MiniCPM5-2B model and everything built for it: `--local` and `--hybrid`, `delegate_local` and helper tasks, drift watch, the llama.cpp engine, its pins and download, `native/midnight-host`, the model lock, the `model`/`engine`/`doctor`/`helper` subcommands, the built-in llama.cpp provider, and the offline release. Also the harness's `task` contract, the Laya review, and the local-model profile.

## Upstream base

The Pi base is `earendil-works/pi` v0.99.1 (`d86654abb`, recorded in `docs/upstreams.lock.json`), merged on 2026-09-30. Pi is now an ancestor in git history: the midnight tree as of `v0.87.1-midnight.5` was committed on top of upstream `v0.87.1` (a graft commit with the same tree as `main`), and `v0.99.1` was merged into it. Later Pi releases are ordinary merges; the steps are in `.midnight.server/skills/upstream-sync.md`.

What the 0.99.1 merge changed beyond taking upstream:

1. MCP is Pi's built-in extension (`builtin:mcp`, `docs/mcp.md`). The bundled `pi-mcp-adapter` and `packaging/extensions` were removed; the loader for extensions beside the executable stays and loads nothing when that directory is absent.
2. Codemode and `tool_search` are built in and inactive until named (`defaultTools: ["+codemode"]` or `--tools`). In the Bun binary the codemode worker is an extra entrypoint in `scripts/build.ps1` and `build-unix.sh`, resolved by path because Bun does not resolve embedded workers by file URL; `pi-codemode`'s `workerUrl` accepts a string for that.
3. `DEFAULT_TOOL_NAMES` uses `powershell` instead of `bash` on Windows, so `defaultTools` modifiers such as `+codemode` keep the Windows default.
4. Compaction is fitted to the window of the model a virtual model routes to, not the virtual model's own window.
5. The `dark` and `light` themes keep the midnight palette; upstream's new `system` theme (terminal colors) is the default.
6. TypeScript is 7.0.2 (`tsc` is the native compiler that `tsgo` previewed). The harness parse gate falls back to Node's parser for JavaScript when the project's TypeScript has no compiler API (TypeScript 7), and leaves TypeScript files unchecked there.
7. Model data in `packages/ai/src/providers/data` was regenerated for schema 6 with `npm run hydrate:model-data`.
8. New upstream code and tests were renamed like the rest: `PI_OAUTH_CALLBACK_HOST` became `MIDNIGHT_SERVER_OAUTH_CALLBACK_HOST`, `.pi/mcp.json` became `.midnight.server/mcp.json`.
9. The built-in llama.cpp extension stays removed (see Removed, 2026-09-27); upstream's llama.cpp classifier API in `pi-ai` is kept.

The earlier 0.85.1 to 0.87.1 port applied `git diff 36b60d2e v0.87.1` as a patch; that history is squashed into `bb1ec164b`.

## Not done

1. **Measuring the harness against plain Pi** on real, larger repositories: success, wall time and cost with prompt cache included.
2. **Product identity leftovers.** Package scopes remain `@earendil-works/*`; many docs, help text and the built-in update checker still refer to Pi.
3. **Release infrastructure.** No Authenticode signing, update/rollback flow, SBOM, or clean-VM run.

## Known test status

`npm run check` passes. The midnight and harness tests pass.

Package tests under `test.sh`'s isolated environment on Windows have failures that do not involve midnight code:

- `coding-agent`: causes seen are the config-directory rename (tests write project settings to `.pi/` while the product reads `.midnight.server/`), tests that pass raw `C:\` paths to `node --import` (Node rejects them on Windows), `pi` vs `midnight.server` strings in expected help text, Windows EPERM vs EACCES, and Git Bash path translation.
- `agent-core`, `durable`, `session-backends/sqlite-node`, `client`, `server`: many files fail to load because package exports point at `dist/`, which is not built (the repository rules forbid `npm run build` without a request).

After the 0.99.1 merge, `./test.sh` on Windows fails 143 tests against 171 on `v0.87.1-midnight.5`: 36 fixed by the regenerated model data and other upstream fixes, none newly broken in existing tests. New upstream tests that fail only on Windows: `durable` `env-node.test.ts` (symlinks need elevation, Git Bash rewrites paths to `/tmp`) and `mcp-command.test.ts` listing a server whose command is missing (Windows reports a closed connection instead of `ENOENT`). `chord` `state-fuzz.test.ts` can exceed its 5 s timeout under the full run and passes alone.

Fixing these is part of finishing the rename and Windows test portability.
