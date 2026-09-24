# midnight.server

A native Windows coding CLI and terminal UI built from a modified [Pi](https://github.com/soliluqoy/pi), with the MiniCPM5-2B Q8_0 model running on the same machine as a local model and helper.

**Status: pre-release.** Local mode, hybrid delegation, the Windows build and the offline package work and were verified on one Windows 10 laptop (CPU only). The quality evaluation, GPU backends, signing, update path and clean-VM qualification are not done. See [implementation status](docs/IMPLEMENTATION_STATUS.md).

## What it does

| Mode | Command | Behavior |
| --- | --- | --- |
| Default / Hybrid | `midnight.server` (same as `midnight.server --hybrid`) | Your configured provider leads. It gets a `delegate_local` tool that hands small read-only jobs to the local model, which starts on first use. MiniCPM also runs a background drift check every few turns and nudges the parent model if it has lost track of the goal. If no provider is configured at all, the session silently starts on the local model instead — not offline-locked, so `/login` still works afterward. |
| Local | `midnight.server --local` | Runs the whole session on the embedded MiniCPM5-2B Q8_0. Starts offline and **blocks every model request to any other provider** for the session. |
| Direct helper | `midnight.server helper inspect "question" file.ts` | Runs one helper task locally, no provider needed. |

The helper (`delegate_local`, `helper`) reads only the workspace files it is given. It has no shell or tools, and it returns a schema-checked result with line evidence. `patch` tasks return a unified diff that is **not applied**. It can also run one read-only git operation itself (`status`, `diff`, `log`, `show`, `blame`) with a fixed argv, never a shell — never anything that mutates the repository.

The engine is the pinned llama.cpp `b11166` CPU build. It runs as a child process under a Windows Job Object owned by the CLI, bound to `127.0.0.1` and protected by a random per-session key. It exits when the CLI exits, including after a crash.

## Install

Release archives (built by `scripts\package.ps1`):

- `midnight.server-windows-x64.zip` (~58 MiB): app and engine. Download the model once with `midnight.server model fetch` (2.5 GiB, resumable, SHA-256 verified).
- `midnight.server-windows-x64-offline.zip` (~2.6 GiB): includes the model and needs no network. GitHub limits release assets to under 2 GiB, so it is also published as `.001`/`.002` parts. Run `join-offline.ps1` in the download folder to reassemble and verify it.

Requirements: Windows 10 or 11, x64, 16 GiB RAM recommended. Node.js, Python, WSL and Git Bash are not required.

```powershell
midnight.server doctor            # check installation
midnight.server doctor --smoke    # also start the engine and generate a reply
midnight.server --local           # interactive, fully local
```

## Performance (Intel i7-8650U laptop, CPU only)

Prompt processing is ~25-30 tokens/s and generation ~9 tokens/s. A one-tool `--local` task took 77-95 s. A helper question over a short file took 13 s. See [measurements](docs/benchmarks/cpu-i7-8650u.md). The 2B model can be wrong, so check its evidence before acting on it.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MIDNIGHT_SERVER_HOME` | `%LOCALAPPDATA%\midnight.server` | Downloaded model/engine, verification cache, logs, helper patch artifacts |
| `MIDNIGHT_SERVER_MODEL` | bundled or downloaded file | Use a specific GGUF path. It must still match the pinned SHA-256. |
| `MIDNIGHT_SERVER_ENGINE_DIR` | bundled or downloaded engine | Use another llama.cpp build directory |
| `MIDNIGHT_SERVER_CONTEXT` | `8192` | Engine context size in tokens |
| `MIDNIGHT_SERVER_THREADS` | logical cores - 2 (max 8) | Generation threads (prompt processing uses all cores) |
| `MIDNIGHT_SERVER_GPU_LAYERS` | `0` | Layers to offload (the pinned engine is CPU-only) |
| `MIDNIGHT_SERVER_IDLE_MS` | `900000` | Stop the hybrid-mode engine after this idle time |
| `MIDNIGHT_SERVER_CODING_AGENT_DIR` | `~\.midnight.server\agent` | Pi settings, sessions, credentials |
| `MIDNIGHT_SERVER_DRIFTWATCH` | `1` | Set to `0` to disable the hybrid-mode drift watcher (the `delegate_local` tool is unaffected) |
| `MIDNIGHT_SERVER_DRIFTWATCH_TURNS` | `6` | Run a drift check after this many assistant turns since the last one |
| `MIDNIGHT_SERVER_DRIFTWATCH_TOKENS` | `4000` | Also run a drift check once context has grown by this many tokens since the last one |
| `MIDNIGHT_SERVER_DRIFTWATCH_COOLDOWN` | `4` | Turns to wait after a nudge before another one can fire |

On Windows the default shell tool and the `!` commands use PowerShell. See [Windows setup](packages/coding-agent/docs/windows.md).

## Build from source

```powershell
.\scripts\bootstrap.ps1 -Install        # check Node/Git/csc, fetch pinned Bun, npm ci --ignore-scripts
.\scripts\build.ps1                      # build\dist\midnight.server-windows-x64-cpu\
.\scripts\fetch-model.ps1                # models\cache\MiniCPM5-2B-Q8_0.gguf (verified)
.\scripts\package.ps1 -IncludeModel      # dist\*.zip, split parts, SHA256SUMS
.\scripts\verify-release.ps1 -Package dist\midnight.server-windows-x64-offline.zip -Smoke
```

`build.ps1` compiles the CLI from TypeScript sources with Bun and `native\midnight-host` with the C# compiler included in Windows. It installs the SHA-256-pinned llama.cpp release into `engine\cpu`. No Visual Studio or CMake is needed. Building llama.cpp from source is not implemented yet.

From a source checkout you can also run `.\pi-test.ps1 <args>`. Set `TSX_TSCONFIG_PATH` to the repo's `tsconfig.json` when running it from another directory.

## Security

- `--local` fails closed: a missing or unverified model or engine is an error, never a fallback to a cloud provider.
- The PowerShell/Bash tools run with your full user permissions; nothing is sandboxed. Only the helper is restricted (workspace-confined reads, no tools).
- Extensions run in-process with full privileges.

## Sources and licenses

Built from [Pi](https://github.com/soliluqoy/pi) (MIT), [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT) and [MiniCPM5-2B](https://huggingface.co/openbmb/MiniCPM5-2B) (Apache-2.0). See [upstream pins](docs/upstreams.lock.json) and [third-party notices](packaging/THIRD_PARTY_NOTICES.md). The design is in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
