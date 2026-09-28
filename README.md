# midnight.server

A coding CLI and terminal UI for Windows, Linux and macOS, built from a modified [Pi](https://github.com/soliluqoy/pi).

Its core is **[the harness](packages/coding-agent/docs/harness.md)**, a deliberately small layer around Pi's tool loop. At every edit it catches broken syntax, bad paths and mismatched text in the same turn, without extra model turns. When the model finishes, it runs the project's own checks once on the changed files and gives one repair round for new failures. It then checks the change for drift from the request. It never rewrites the conversation (the prompt cache keeps working), and plain Pi is the baseline it has to beat.

**Status: pre-release.** The goal is a measured one: a fast model (GPT-6 Luna) with midnight.server within 5 success points of a strong model (GPT-6 Astra, thinking high) on fresh repository tasks, with latency and cost reported alongside. That gap has not been measured yet. The plan and the evidence so far are in [the rebuild plan](docs/HARNESS_REBUILD_PLAN.md), [harness results](evals/harness/RESULTS.md) and [drift results](evals/drift/RESULTS.md).

## Quick start

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/soliluqoy/midnight.server/main/scripts/get.ps1 | iex
```

Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/soliluqoy/midnight.server/main/scripts/get.sh | sh
```

Then run `midnight.server`, and `/login` or set an API key for your provider. See [Install](#install) for other options.

## Features

- **Harness.** Several parts:
  - a syntax gate and edit, path and shell repairs at every tool call;
  - the project's checks (configured or detected) run once when the model finishes, with failures the project already had held back;
  - one repair round;
  - a drift guard that asks once to fix or disclose a change that does not match the request;
  - a sanctioned way to stop and report a blocker.

  Opt-in: a context pack, a `lookup` tool, language-server errors per edit, and advice from a stronger model. [Details](packages/coding-agent/docs/harness.md).
- **Plan and build modes.** Press Tab in an empty editor to switch. Plan mode limits the model to read-only tools (read, grep, find, ls) and asks it for a step-by-step plan; build mode restores the full tool set.
- **Session sidebar.** In fullscreen mode (`/settings` → TUI mode) a sidebar shows the session title, git branch with changed/staged counts and ahead/behind, context usage and cost, the model, and the files changed this session with +/- line counts. Click the BUILD/PLAN chip to switch modes (also in the footer), the model to change it, and a changed file to preview it. It appears automatically on terminals 110+ columns wide; Alt+S toggles it.
- **File explorer.** Alt+E opens a file tree on the left (fullscreen mode) with git status marks. Enter adds `@path` to the prompt, Space previews the file, Escape goes back. It shows on its own only on terminals 150+ columns wide.
- **Side threads.** Alt+T turns the editor into a question box about the newest tool call or reply (Up/Down picks another). Ask with the session model or another model. The answer folds under that item, the main agent never sees it, and it can keep running. Alt+T again manages threads: `m` sends one to the main agent, `b` redoes the item from before it with the thread in your prompt. `/ask` asks about the newest item. [Details](packages/coding-agent/docs/sessions.md#ask-side-questions).
- **Command palette.** Alt+X opens a fuzzy-searchable list of actions and slash commands.
- **Automatic session titles.** After the first exchange the session model names the session, then updates the title as the work moves on (at most every 3 runs and 5 minutes). A name you set with `--name` or `/name` is kept. The title shows in the sidebar and terminal title, not the footer.
- **Native Windows.** PowerShell is the default shell tool; no Node.js, Python, WSL, or Git Bash is needed to run it.

## Escalation

Off by default. With `features: { "escalation": true }` in `.midnight.server/harness.json`, the harness asks a stronger model for one piece of advice when the checks fail, and sends it with the repair feedback. It uses `anthropic/claude-opus-5-5` when you have credentials for it; set another model or caps with `escalation`. `/harness` shows the calls made and their cost. A result with escalation on is a cascade result, not the session model alone.

## Install

### Windows

```powershell
irm https://raw.githubusercontent.com/soliluqoy/midnight.server/main/scripts/get.ps1 | iex
```

This downloads the newest release, verifies it against `SHA256SUMS`, installs it to `%LOCALAPPDATA%\Programs\midnight.server` and adds it to your PATH. Run it again to upgrade. Set `MIDNIGHT_SERVER_VERSION` to a release tag to install a specific version.

Requirements: Windows 10 or 11, x64.

**Manual install.** Download `midnight.server-windows-x64.zip` from [Releases](https://github.com/soliluqoy/midnight.server/releases), check it against `SHA256SUMS` with `(Get-FileHash .\midnight.server-windows-x64.zip).Hash`, extract it anywhere and run `midnight.server.exe` from that folder.

| Path | Contents |
| --- | --- |
| `%LOCALAPPDATA%\Programs\midnight.server` | The app (replaced on upgrade) |
| `~\.midnight.server\agent` | Settings, sessions and provider credentials (`MIDNIGHT_SERVER_CODING_AGENT_DIR`) |

**Uninstall.**

```powershell
$app = Join-Path $env:LOCALAPPDATA "Programs\midnight.server"
Remove-Item -Recurse -Force $app
[Environment]::SetEnvironmentVariable("Path", (([Environment]::GetEnvironmentVariable("Path", "User") -split ";") -ne $app -join ";"), "User")
Remove-Item -Recurse -Force "$HOME\.midnight.server"   # settings, sessions, credentials
```

### Linux and macOS

```sh
curl -fsSL https://raw.githubusercontent.com/soliluqoy/midnight.server/main/scripts/get.sh | sh
```

This downloads the newest release for your platform, verifies it against `SHA256SUMS`, installs it to `~/.local/lib/midnight.server` and puts a `midnight.server` launcher in `~/.local/bin`. `MIDNIGHT_SERVER_VERSION`, `MIDNIGHT_SERVER_INSTALL_DIR` and `MIDNIGHT_SERVER_BIN_DIR` override the version and locations.

**Debian and Ubuntu.** `sudo apt install ./midnight.server-linux-x64.deb` installs to `/opt/midnight.server` with `/usr/bin/midnight.server`.

Release archives: `midnight.server-linux-x64.tar.gz`, `midnight.server-linux-x64.deb`, and `midnight.server-darwin-arm64.tar.gz` (Apple Silicon). Intel Macs are not released; build them from source (see below).

Requirements: Linux x64 with glibc 2.35 or newer (Ubuntu 22.04, Debian 12 or later), or macOS 13 or newer on Apple Silicon (M1 or later).

**macOS: "cannot be opened because the developer cannot be verified".** The macOS builds are not signed by Apple. The install script avoids this. If you downloaded the tarball in a browser, clear the quarantine flag once: `xattr -dr com.apple.quarantine ~/path/to/midnight.server`.

**Uninstall.** `rm -rf ~/.local/lib/midnight.server ~/.local/bin/midnight.server` (or `sudo apt remove midnight.server`), then `rm -rf ~/.midnight.server` for settings, sessions and credentials.

## Troubleshooting

- **`midnight.server` is not recognized.** Terminals opened before the install don't see the new PATH. Open a new terminal, or run `$env:Path += ";$env:LOCALAPPDATA\Programs\midnight.server"`.
- **The install command fails with a download or TLS error.** A proxy or antivirus is blocking GitHub. Use the manual install above.

On Windows the default shell tool and the `!` commands use PowerShell. See [Windows setup](packages/coding-agent/docs/windows.md).

## Build from source

```powershell
.\scripts\bootstrap.ps1 -Install        # check Node/Git, fetch pinned Bun, npm ci --ignore-scripts
.\scripts\build.ps1                      # build\dist\midnight.server-windows-x64\
.\scripts\package.ps1                    # dist\midnight.server-windows-x64.zip, SHA256SUMS
.\scripts\verify-release.ps1 -Package dist\midnight.server-windows-x64.zip
```

On Linux or macOS, with the pinned Bun on PATH and `npm ci --ignore-scripts` done:

```sh
bash scripts/build-unix.sh               # build/dist/midnight.server-<platform>/
bash scripts/package-unix.sh             # dist/*.tar.gz (and .deb on Linux x64), SHA256SUMS-<platform>
node scripts/verify-release.mjs dist/midnight.server-<platform>.tar.gz
```

Pushing a `v*-midnight.*` tag runs `.github/workflows/midnight-release.yml`, which builds and verifies every platform and attaches the archives to a draft release.

From a source checkout you can also run `.\pi-test.ps1 <args>`. Set `TSX_TSCONFIG_PATH` to the repo's `tsconfig.json` when running it from another directory.

## Security

- The PowerShell/Bash tools run with your full user permissions; nothing is sandboxed.
- Project checks, detected checks and language servers run project code, so they require project trust.
- Extensions run in-process with full privileges.

## Sources and licenses

Built from [Pi](https://github.com/soliluqoy/pi) (MIT). See [upstream pins](docs/upstreams.lock.json) and [third-party notices](packaging/THIRD_PARTY_NOTICES.md).
