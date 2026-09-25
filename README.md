# midnight.server

A native Windows coding CLI and terminal UI built from a modified [Pi](https://github.com/soliluqoy/pi), with the MiniCPM5-2B Q8_0 model running on the same machine as a local model and helper.

Its headline feature is **[drift watch](#drift-watch)**: while a cloud model does the work, the local model keeps checking, at no token cost, that it is still doing what you asked. When it isn't, the local model steps in with a short reminder.

**Status: pre-release.** Local mode, hybrid delegation, automatic GPU/CPU engine selection, the Windows build and the offline package work and were verified on one Windows 10 laptop (CPU and Intel integrated GPU) and on Linux under WSL. Released binaries are Windows x64 only. The quality evaluation, the CUDA/ROCm/SYCL/OpenVINO/Metal backends on real hardware, Linux and macOS releases, signing and clean-VM qualification are not done. See [implementation status](docs/IMPLEMENTATION_STATUS.md).

## Quick start

```powershell
irm https://raw.githubusercontent.com/soliluqoy/midnight.server/main/scripts/get.ps1 | iex
midnight.server doctor --smoke    # optional: downloads the model and checks everything works
midnight.server                   # start a session
```

The first local run downloads the 2.5 GiB model and picks the fastest engine for your hardware; after that it starts in seconds. See [Install](#install) for other options.

## Features

- **Drift watch.** The local model keeps an eye on your cloud model during long sessions. It catches the model dropping a constraint you set, reversing an earlier decision, or wandering off task, and adds a one- or two-sentence correction. It runs in the background, is on by default, and uses no cloud tokens. [How it works](#drift-watch).
- **Local model.** MiniCPM5-2B Q8_0 runs entirely on your machine through a SHA-256-pinned llama.cpp engine. No account or network required after the first download.
- **GPU when it helps.** Every official llama.cpp build (CPU, Vulkan, CUDA, ROCm, SYCL, OpenVINO, Metal, ...) is pinned. On first start midnight.server runs the model on your GPU and CPU and keeps whichever is faster; no GPU is needed. [Details](#gpu-and-backends).
- **Hybrid delegation.** Your configured provider stays in charge and gets a `delegate_local` tool to hand small, bounded, read-only jobs to the local model, so it doesn't spend cloud tokens on cheap lookups.
- **Direct helper command.** `midnight.server helper <summarize|classify|inspect|plan|patch> "question" file...` runs one task locally, with no provider configured at all.
- **Workspace-confined, read-only.** The helper only reads files it is explicitly given, resolved and confined to the workspace (symlinks, junctions, `..`, other drives and UNC paths all rejected). It has no shell tool and cannot write.
- **Read-only git context.** The helper can run `status`, `diff`, `log`, `show`, or `blame` itself, with a fixed argv (never a shell) and byte-capped output, to answer questions about history without any write access.
- **Patch proposals, never applied.** `patch` tasks return an exact-match, evidence-backed unified diff for you to review; the helper never writes to disk.
- **Zero-setup first run.** `--local`, the no-provider-configured fallback, and the first `delegate_local`/drift-watch call all download the model and engine automatically if they're missing — resumable, SHA-256 verified, never used unverified.
- **Process isolation.** The engine runs under a Windows Job Object owned by the CLI, bound to loopback with a random per-session key, and exits with its descendants when the CLI exits, including after a crash.
- **Diagnostics.** `doctor [--smoke]`, `model status|verify|fetch`, `engine status|fetch|use|probe` check the install, show and change the engine backend, and, with `--smoke`, start the engine and generate a real reply.
- **Plan and build modes.** Press Tab in an empty editor to switch. Plan mode limits the model to read-only tools (read, grep, find, ls, `delegate_local`) and asks it for a step-by-step plan; build mode restores the full tool set.
- **Session sidebar.** In fullscreen mode (`/settings` → TUI mode) a sidebar shows the session title, git branch with changed/staged counts and ahead/behind, context usage and cost, the model, the local engine and drift-watch state, and the files changed this session with +/- line counts. It appears automatically on terminals 110+ columns wide; Alt+S toggles it.
- **Command palette.** Alt+X opens a fuzzy-searchable list of actions and slash commands.
- **Automatic session titles.** After the first exchange the local model names the session, at no cloud cost, unless you already named it. It is skipped until the local model is installed.
- **Native Windows.** PowerShell is the default shell tool; no Node.js, Python, WSL, or Git Bash is needed to run it.
- **Offline packaging.** The model-included archive needs no network at all once downloaded.

## What it does

| Mode | Command | Behavior |
| --- | --- | --- |
| Default / Hybrid | `midnight.server` (same as `midnight.server --hybrid`) | Your configured provider leads. It gets a `delegate_local` tool that hands small read-only jobs to the local model, which starts on first use. MiniCPM also runs a background drift check every few turns and nudges the parent model if it has lost track of the goal. If no provider is configured at all, the session silently starts on the local model instead — not offline-locked, so `/login` still works afterward. |
| Local | `midnight.server --local` | Runs the whole session on the embedded MiniCPM5-2B Q8_0, downloading it and the engine automatically on first run if not already installed. Starts offline and **blocks every model request to any other provider** for the session. |
| Direct helper | `midnight.server helper inspect "question" file.ts` | Runs one helper task locally, no provider needed. |

The helper (`delegate_local`, `helper`) reads only the workspace files it is given. It has no shell or tools, and it returns a schema-checked result with line evidence. `patch` tasks return a unified diff that is **not applied**. It can also run one read-only git operation itself (`status`, `diff`, `log`, `show`, `blame`) with a fixed argv, never a shell — never anything that mutates the repository.

The engine is llama.cpp `b11166`: the CPU build ships in the release, and a GPU build is downloaded when it is faster on your machine ([GPU and backends](#gpu-and-backends)). It runs as a child process under a Windows Job Object owned by the CLI, bound to `127.0.0.1` and protected by a random per-session key. It exits when the CLI exits, including after a crash.

## Drift watch

**Problem.** In a long agent session, context piles up and the model tends to lose the thread. It drops a constraint you gave early on, reverses a decision it already made, or starts a side quest without saying so. You usually notice several turns later, after the tokens are spent and the diff has grown.

**Example (illustrative).** You ask for a fix to the failing date-parsing test, with *"don't change the public API"*. Eight turns later the model has changed `parseDate`'s exported signature and is reworking the logger. Drift watch runs its check, decides the model is `drifting`, and adds this to the session:

```
[local focus check: drifting] The task said not to change the public API, but parseDate's exported signature was changed.
```

The cloud model receives this reminder with your next prompt and can correct course before it goes further.

**How it works.**

1. **When it runs.** It checks after every 6 assistant turns, or sooner if the context has grown by 4,000 tokens since the last check.
2. **What it reads.** A read-only copy of the conversation with the middle cut out. It keeps the start (about 1.5 KB, where your goal and constraints usually are) and the most recent activity (about 8.5 KB).
3. **What it decides.** MiniCPM, running with no tools, returns a schema-checked verdict: `on_track`, `drifting` (a constraint or earlier decision was dropped), or `off_task` (unrelated work). If it returns invalid JSON, it gets one retry.
4. **What it does.** Nothing when the model is `on_track`. Otherwise it adds a short reminder naming the goal or constraint being missed. After a nudge it stays quiet for at least 4 turns, so it can't nag.

**What it costs.**

- **No cloud tokens for the check.** The check runs on the local model; the only thing added to the cloud model's context is the short reminder, and only when it fires.
- **It never blocks you.** On a CPU laptop a check takes about 10-30 s, so it runs in the background and your session keeps going while it thinks.
- **Zero setup.** The first check downloads the local model if it isn't installed yet.
- **It stays out of the way when it can't run.** If the local model can't be set up, drift watch turns itself off for the rest of the session instead of showing errors.

**When it's active.** It runs in default/hybrid mode, where a cloud model leads. It is off in `--local` sessions and when the session has fallen back to the local model, because there is no separate model to watch.

**Tuning.**

| Variable | Default | Effect |
| --- | --- | --- |
| `MIDNIGHT_SERVER_DRIFTWATCH` | `1` | `0` turns it off (`delegate_local` is unaffected) |
| `MIDNIGHT_SERVER_DRIFTWATCH_TURNS` | `6` | Check after this many assistant turns |
| `MIDNIGHT_SERVER_DRIFTWATCH_TOKENS` | `4000` | Also check after this much context growth |
| `MIDNIGHT_SERVER_DRIFTWATCH_COOLDOWN` | `4` | Minimum turns between two nudges |

Lower the turn and token values to check more often, for example on long autonomous runs. Raise them if the checks slow your machine down. The 2B model judges drift with a limited view, so treat a nudge as a prompt to look, not a verdict.

## Best way to use it

- **Default (hybrid) for daily coding.** Just run `midnight.server`. Your configured provider leads and automatically gets `delegate_local` and the drift watcher — there is nothing to opt into.
- **`--local` when you want zero network calls**: offline, air-gapped, or reviewing code you don't want leaving the machine. It's a 2B model, so expect it to be slower and weaker than a cloud model on multi-step work.
- **First run needs one network trip.** If the model (2.5 GiB) isn't installed yet, the first `--local` run, first no-provider session, or first `delegate_local`/helper call downloads and verifies it automatically — expect that one run to take a while. Run `midnight.server model fetch` ahead of time if you want to do that download on your own schedule, or on a fully offline machine, use the `-offline.zip` release, which already includes the model.
- **`helper` for one-off questions** when a full session is overkill: `midnight.server helper inspect "why does this throw?" src/foo.ts`. No provider needed, and faster than starting an agent loop.
- **Keep helper inputs small.** It answers best under roughly 6 KB of source per call; a 12 KB file was measured to return a wrong answer instead of escalating (see [implementation status](docs/IMPLEMENTATION_STATUS.md)). Point it at the specific file or function rather than the whole repo.
- **Treat `patch` output as a proposal.** It's an unapplied diff built from exact-match text edits — read it before applying it yourself; the 2B model can be wrong (see [measurements](docs/benchmarks/cpu-i7-8650u.md)).
- **Leave drift watch on for long sessions.** Long sessions are where it pays off. When a nudge appears, check the constraint it names before you continue. If it fires too often or too rarely, see [tuning](#drift-watch).
- **Run `doctor --smoke` after install** to confirm the model, engine, and process host all work end to end before relying on it mid-task.

## Install

In PowerShell:

```powershell
irm https://raw.githubusercontent.com/soliluqoy/midnight.server/main/scripts/get.ps1 | iex
```

This downloads the newest release, verifies it against `SHA256SUMS`, installs it to `%LOCALAPPDATA%\Programs\midnight.server` and adds it to your PATH, so `midnight.server` works right away. Run it again to upgrade. Set `MIDNIGHT_SERVER_VERSION` to a release tag to install a specific version.

Release archives (built by `scripts\package.ps1`):

- `midnight.server-windows-x64.zip` (~58 MiB): app and engine. The model (2.5 GiB) downloads automatically the first time it's needed — resumable, SHA-256 verified — or pre-fetch it with `midnight.server model fetch`.
- `midnight.server-windows-x64-offline.zip` (~2.6 GiB): includes the model and needs no network. GitHub limits release assets to under 2 GiB, so it is also published as `.001`/`.002` parts. Run `join-offline.ps1` in the download folder to reassemble and verify it.

Requirements: Windows 10 or 11, x64, 16 GiB RAM recommended (8 GiB works with less headroom), about 3 GiB of disk for the model and engine. A GPU is optional. Node.js, Python, WSL and Git Bash are not required.

```powershell
midnight.server doctor            # check installation
midnight.server doctor --smoke    # also start the engine and generate a reply
midnight.server --local           # interactive, fully local
```

**Manual install.** Download `midnight.server-windows-x64.zip` from [Releases](https://github.com/soliluqoy/midnight.server/releases), check it against `SHA256SUMS` with `(Get-FileHash .\midnight.server-windows-x64.zip).Hash`, extract it anywhere and run `midnight.server.exe` from that folder (add the folder to PATH to run it from anywhere).

**Upgrade.** Run the install command again. Your settings, sessions, model and engines are kept.

**Where things live.**

| Path | Contents |
| --- | --- |
| `%LOCALAPPDATA%\Programs\midnight.server` | The app and bundled CPU engine (replaced on upgrade) |
| `%LOCALAPPDATA%\midnight.server` | Model, downloaded GPU engines, saved backend choice, engine logs (`MIDNIGHT_SERVER_HOME`) |
| `~\.midnight.server\agent` | Settings, sessions and provider credentials (`MIDNIGHT_SERVER_CODING_AGENT_DIR`) |

**Uninstall.**

```powershell
$app = Join-Path $env:LOCALAPPDATA "Programs\midnight.server"
Remove-Item -Recurse -Force $app
[Environment]::SetEnvironmentVariable("Path", (([Environment]::GetEnvironmentVariable("Path", "User") -split ";") -ne $app -join ";"), "User")
Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA "midnight.server")   # model and engines (~3 GiB)
Remove-Item -Recurse -Force "$HOME\.midnight.server"                         # settings, sessions, credentials
```

## Performance (Intel i7-8650U laptop, CPU only)

On the CPU, prompt processing is ~25-35 tokens/s and generation ~8-9 tokens/s. Its integrated UHD 620 GPU was slower (~22 and ~4 tokens/s), so automatic selection keeps the CPU there; a discrete GPU is typically several times faster than either. A one-tool `--local` task took 77-95 s. A helper question over a short file took 13 s. See [measurements](docs/benchmarks/cpu-i7-8650u.md). The 2B model can be wrong, so check its evidence before acting on it.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MIDNIGHT_SERVER_HOME` | `%LOCALAPPDATA%\midnight.server` | Downloaded model/engine, verification cache, logs, helper patch artifacts |
| `MIDNIGHT_SERVER_MODEL` | bundled or downloaded file | Use a specific GGUF path. It must still match the pinned SHA-256. |
| `MIDNIGHT_SERVER_BACKEND` | `auto` | Engine backend: `auto`, or one from `engine status` (`cpu`, `vulkan`, `cuda`, `cuda-13`, `rocm`, `sycl`, `openvino`, `metal`, ...). See [GPU and backends](#gpu-and-backends) |
| `MIDNIGHT_SERVER_ENGINE_DIR` | bundled or downloaded engine | Use your own llama.cpp build directory (every layer is offloaded; a CPU-only build ignores that) |
| `MIDNIGHT_SERVER_CONTEXT` | `8192` | Engine context size in tokens |
| `MIDNIGHT_SERVER_THREADS` | logical cores - 2 (max 8) | Generation threads (prompt processing uses all cores) |
| `MIDNIGHT_SERVER_GPU_LAYERS` | from the backend (`0` on CPU, all on GPU) | Layers to offload to the GPU |
| `MIDNIGHT_SERVER_IDLE_MS` | `900000` | Stop the hybrid-mode engine after this idle time |
| `MIDNIGHT_SERVER_CODING_AGENT_DIR` | `~\.midnight.server\agent` | Pi settings, sessions, credentials |
| `MIDNIGHT_SERVER_DRIFTWATCH` | `1` | Set to `0` to disable the hybrid-mode drift watcher (the `delegate_local` tool is unaffected) |
| `MIDNIGHT_SERVER_DRIFTWATCH_TURNS` | `6` | Run a drift check after this many assistant turns since the last one |
| `MIDNIGHT_SERVER_DRIFTWATCH_TOKENS` | `4000` | Also run a drift check once context has grown by this many tokens since the last one |
| `MIDNIGHT_SERVER_DRIFTWATCH_COOLDOWN` | `4` | Turns to wait after a nudge before another one can fire |

## GPU and backends

midnight.server pins every official llama.cpp build for the engine release it uses (Windows, Linux and macOS; x64 and ARM64) by SHA-256, and downloads the one it needs on first start.

With the default `auto` backend, the first engine start (about two minutes, once) does this:

1. On Apple Silicon it tries Metal; on Windows and Linux it downloads the Vulkan build (~30 MiB), which works with NVIDIA, AMD and Intel GPUs, and lists the GPUs it can use.
2. If a GPU has enough memory for the model, it runs the model on the GPU and on the CPU and estimates the time for a typical helper task (2,000 prompt tokens, 300 generated) on each.
3. It keeps the GPU only if it is at least 10% faster. Integrated GPUs are often slower than the CPU at generating text: on an i7-8650U the UHD 620 took ~167 s against ~96 s on the CPU.

The result is saved. If a GPU chosen this way later fails to start, the session falls back to the CPU and saves that instead. A backend that fails to start or to generate is never chosen.

CUDA, ROCm, SYCL, OpenVINO and others are not tried automatically, because they are large (up to ~730 MiB with the CUDA runtime) or need vendor runtimes installed. Choose one explicitly:

```
midnight.server engine status             # selected backend, installed and available builds
midnight.server engine probe              # measure GPU vs CPU again, print the numbers, save the result
midnight.server engine use cuda           # always use this backend (no automatic fallback)
midnight.server engine use auto           # back to automatic selection
midnight.server engine fetch vulkan       # download a build ahead of time
```

**Supported hardware.** Builds pinned for llama.cpp `b11166`; "run" means a maintainer started the engine and generated a reply with the model on it.

| Platform | Automatic | Opt-in | Run by maintainers |
| --- | --- | --- | --- |
| Windows x64 | CPU, Vulkan | `cuda` (12.4), `cuda-13`, `rocm`, `sycl`, `openvino` | CPU; Vulkan on Intel UHD 620 |
| Windows ARM64 | CPU | `cuda-13`, `opencl` (Adreno) | none |
| Linux x64 | CPU, Vulkan | `cuda` (12.8), `cuda-13`, `rocm`, `sycl`, `openvino` | CPU (WSL; Vulkan found no GPU there) |
| Linux ARM64 | CPU, Vulkan | `cuda-13`, `hexagon` (Snapdragon) | none |
| macOS Apple Silicon | Metal | none | none |
| macOS Intel | CPU | none | none |

Engines for every platform are pinned, but the released app itself is Windows x64 only so far; on Linux and macOS it currently runs from a source build.

`cuda` selects `cuda-12` (works with older NVIDIA drivers); `cuda-13` needs a recent driver. On Linux the CPU and Vulkan builds need `libgomp1` (`sudo apt install libgomp1`) and a Vulkan driver (`mesa-vulkan-drivers` or your GPU vendor's). Only the CPU and Vulkan builds have been run by the maintainers; report results from other backends with `midnight.server doctor --smoke`.

On Windows the default shell tool and the `!` commands use PowerShell. See [Windows setup](packages/coding-agent/docs/windows.md).

## Troubleshooting

- **`midnight.server` is not recognized.** Terminals opened before the install don't see the new PATH. Open a new terminal, or run `$env:Path += ";$env:LOCALAPPDATA\Programs\midnight.server"`.
- **The install command fails with a download or TLS error.** A proxy or antivirus is blocking GitHub. Use the manual install above.
- **The first local run takes minutes.** It downloads the model (2.5 GiB) and, with `auto`, measures GPU against CPU (about two minutes, once). `midnight.server model fetch` and `midnight.server engine probe` do both ahead of time.
- **The engine fails to start.** The error shows the end of the engine log; the full log is `%LOCALAPPDATA%\midnight.server\logs\engine.log`. For a GPU backend you chose, check the driver, or return to automatic selection with `midnight.server engine use auto`.
- **It picked the CPU but you have a GPU.** Run `midnight.server engine probe` to see the measured speeds. If the GPU has less memory than the model needs (about 3 GiB) or was slower, the CPU is the right choice. To force it anyway: `midnight.server engine use vulkan` (or `cuda`).
- **Linux: `libgomp.so.1: cannot open shared object file`.** Install it with `sudo apt install libgomp1`.
- **Answers are wrong or incomplete.** It is a 2B model. Give the helper smaller inputs (under about 6 KB) and check its evidence before acting on it.

## Build from source

```powershell
.\scripts\bootstrap.ps1 -Install        # check Node/Git/csc, fetch pinned Bun, npm ci --ignore-scripts
.\scripts\build.ps1                      # build\dist\midnight.server-windows-x64-cpu\
.\scripts\fetch-model.ps1                # models\cache\MiniCPM5-2B-Q8_0.gguf (verified)
.\scripts\package.ps1 -IncludeModel      # dist\*.zip, split parts, SHA256SUMS
.\scripts\verify-release.ps1 -Package dist\midnight.server-windows-x64-offline.zip -Smoke
```

`build.ps1` compiles the CLI from TypeScript sources with Bun and `native\midnight-host` with the C# compiler included in Windows. It installs the SHA-256-pinned llama.cpp CPU build into `engine\cpu` using the built CLI's own `engine fetch`. `node scripts/generate-engine-pins.mjs <tag>` re-pins every engine build to another llama.cpp release. No Visual Studio or CMake is needed. Building llama.cpp from source is not implemented yet.

From a source checkout you can also run `.\pi-test.ps1 <args>`. Set `TSX_TSCONFIG_PATH` to the repo's `tsconfig.json` when running it from another directory.

## Security

- `--local` fails closed: a corrupted model/engine, or a `MIDNIGHT_SERVER_MODEL`/`MIDNIGHT_SERVER_ENGINE_DIR` override pointing at nothing, is an error — never a silent fallback to a cloud provider. A missing model or engine with no override set is downloaded and verified automatically instead of erroring.
- The PowerShell/Bash tools run with your full user permissions; nothing is sandboxed. Only the helper is restricted (workspace-confined reads, no tools).
- Extensions run in-process with full privileges.

## Sources and licenses

Built from [Pi](https://github.com/soliluqoy/pi) (MIT), [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT) and [MiniCPM5-2B](https://huggingface.co/openbmb/MiniCPM5-2B) (Apache-2.0). See [upstream pins](docs/upstreams.lock.json) and [third-party notices](packaging/THIRD_PARTY_NOTICES.md). The design is in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
