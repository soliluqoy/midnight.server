# midnight.server

A session sidebar and file explorer for **Pi**, with a default blue theme, compact tool output, automatic session titles, and token-speed stats.

Requires **Pi 1.0.4**, **Node.js 22.19+**, and Git on PATH. Side panels need fullscreen mode. No build step or runtime dependencies beyond Pi.

[**v0.4.0**](https://github.com/soliluqoy/midnight.server/releases/tag/v0.4.0) returns Midnight to a Pi-only extension. Claude Code and Codex CLI integrations are no longer included.

![Midnight's file explorer, session sidebar, and folder menu](docs/images/midnight-preview.jpg)

## Install

```powershell
pi install git:github.com/soliluqoy/midnight.server
```

Restart Pi or run `/reload`, then choose fullscreen TUI mode in `/settings`. Source archives, a packaged `.tgz`, and checksums are available from [GitHub Releases](https://github.com/soliluqoy/midnight.server/releases).

To try a local checkout:

```powershell
git clone https://github.com/soliluqoy/midnight.server.git
cd midnight.server
pi --extension . --tui-mode fullscreen
```

**Load only one Midnight source.** For local development, use the checkout instead of the Git-installed copy. Check `pi list`; duplicate copies compete for panels and shortcuts.

## Theme

Midnight bundles the **`midnight`** dark theme with a **Midnight Signal** treatment: signature blue (`#6cb6ff`) for actions and session identity, ice-blue focus cues, deep navy selections/messages, and quiet steel-blue chrome. Editor borders brighten from deep blue to ice as thinking increases (including `xhigh` and `max`). Syntax highlighting uses blue functions, cyan strings, and amber numbers; success, warning, error, and diff colors keep their distinct semantic colors.

Explorer marks keyboard focus with a short blue selection rail and an ice-blue filename—not a full-height bright border. Its blue `●` marks session-touched files with pending changes; Git letters retain their own status colors. The sidebar aligns telemetry and diff-count columns, preserves the filename end of long paths, and keeps stale, unavailable, and conflict warnings explicit. No animations or special icon font are required.

On interactive startup, Midnight selects and saves this default if no theme preference is configured and Pi is still using its default `system` theme. Explicit user, project, and `--use-theme` selections are preserved. To switch an existing setup, select **midnight** in `/settings` → **Theme**; selecting another theme there also opts out of the default.

Load the **package directory**, not only `src/index.ts`, so Pi discovers the bundled theme as well as the extension. Themes apply in regular and fullscreen TUI mode; non-interactive runs do not change theme settings. The terminal's own background color is unchanged.

## Controls

| Key | Action |
| --- | --- |
| Alt+S | Toggle the right session sidebar |
| Alt+E | Show/focus the left Explorer; hide it when already focused |
| Up/Down, PageUp/PageDown | Move through files |
| Right/Left | Expand/collapse a folder or select its parent |
| Enter | Open a folder or insert `@path` into the prompt |
| Space | Preview a file without editing it |
| Alt+G | Open the Explorer's folder/project menu |
| Alt+Up | Browse the parent folder |
| Alt+Home | Return to the session's project folder |
| Escape | Close a preview or return to the prompt |
| Ctrl+O | Expand/collapse tool output |

File-navigation keys apply while Explorer is focused. Other typing returns to the prompt. Click to select, double-click to insert a file, and use the mouse wheel to scroll. Click the sidebar's model name to choose a model. In a preview, Enter inserts a file reference.

Both panels start in `auto` mode: the sidebar appears at 110 columns and Explorer at 150. Panels hide when the terminal is too narrow, even when explicitly opened.

## Features

### Session sidebar

Starts with **MIDNIGHT / SESSION** and the session title, followed by Git status, a thin context meter with a right-aligned percentage, token totals, cost, model/thinking level, and session-touched files. Context pressure turns amber above 70% and red above 90%; unknown usage is never drawn as an empty meter.

While the sidebar is visible, repeated session/model/usage fields disappear from Pi's footer. Cache stats and extension statuses remain. Hiding the sidebar restores the normal footer. Explorer hides the footer's directory path only when it shows the same working directory.

### Session files and diffs

**SESSION FILES** lists paths touched by successful `edit`/`write` calls on the current conversation branch that still have pending changes. Restoring, committing, or removing those changes clears their rows and Explorer dots on the next refresh. Shell-only changes to never-touched paths appear in Git/Explorer marks, not this list.

This is **current Git state for session-touched paths**, not an exact session-start diff or a claim that the session authored every change. Pre-existing and external edits can be included. Branch navigation changes the candidate list, not disk contents or saved messages. Files in other repositories are checked separately; the Git summary still describes the working project.

Click a file for its current diff. Staged and unstaged changes are shown separately; row totals sum both layers. Untracked files are compared against empty content. Conflicts, binary files, and unsupported changes show a status instead of invented line counts. Diff previews are limited to 1 MiB and 20,000 source lines.

Unverifiable paths appear under **RECORDED FILES** as history only. Their previews show recorded operations, not a current diff, and they have no pending dot or current line counts. Refreshes mark old data as updating; read failures are not treated as clean state.

### Explorer and project switching

Explorer includes hidden and ignored files, loads folders only when expanded, and supports read-only previews. Binary files and files larger than 1 MiB show an explanation instead of a preview.

Use **Alt+E → Alt+G** to browse the parent, project, home, or an entered folder. The `..` row also opens the parent. Relative paths resolve from the current Explorer location; quotes, spaces, `~`, other drives, and accessible network shares are supported.

**Browsing never changes the agent's working project.** Use **Open this folder as working project…**, **Switch working project…**, or `/midnight project <path>` to switch explicitly. Command-relative paths resolve from the working project.

Switching asks for confirmation and creates a fresh persistent Pi session. It carries over only your unsent draft—not conversation history—so review relative file references. It is blocked while work, compaction, or queued messages remain, and is unavailable with `--no-session`. Use `/resume` and show all projects to return to the old conversation. A header-only session file left unchanged by hooks is removed if switching is cancelled; a fatal destination-initialization error may require restarting Pi and resuming the old session.

### Compact tools, titles, and speed

- **Compact tools:** one-line activity rows replace tool-output boxes: `○` queued, `●` running, `✓` completed, and `!` failed, followed by a muted operation name, readable target, and compact result. Long targets are clipped before the result so failure status remains visible. Ctrl+O or a click expands Pi's normal output; failures remain visible. Recognized expanded codemode command results are formatted for readability. Saved/model-facing results are unchanged. Use `/midnight compact off` for Pi's default rendering; Ctrl+T controls thinking blocks separately.
- **Automatic titles:** unnamed interactive sessions get short titles from the current model. Named sessions have a five-minute request cooldown, and unchanged conversation text skips the request. Manual `/name` titles are preserved; `/midnight title off` disables automatic naming and `/midnight title auto` resumes it. These settings survive reload/resume. **Title requests use your provider and may incur charges.**
- **Token speed:** the footer shows tokens/sec, response duration, and time to first token (TTFT), in fullscreen and regular TUI mode. Measurements include turn preparation and network time but exclude tool execution. `~` means a streaming estimate; reported output tokens replace it on completion. Missing timing stays unavailable. These stats make no extra model requests.

## Commands

Angle brackets describe an argument; omit the brackets when typing a command.

| Command | Action |
| --- | --- |
| `/midnight sidebar` | Toggle the sidebar |
| `/midnight explorer` | Show/focus or hide Explorer |
| `/midnight sidebar <auto\|always\|hidden>` | Set sidebar visibility |
| `/midnight explorer <auto\|always\|hidden>` | Set Explorer visibility |
| `/midnight explorer go` | Open the folder menu |
| `/midnight explorer go <path>` | Browse a folder |
| `/midnight explorer parent` | Browse the parent folder |
| `/midnight explorer project` | Return to the project folder |
| `/midnight project` | Ask for a new working project |
| `/midnight project <path>` | Switch to a new working project |
| `/midnight compact <on\|off>` | Enable/disable compact tool rendering |
| `/midnight title <auto\|off>` | Enable/disable automatic titles |
| `/midnight refresh` | Refresh Git and file state |

Panel modes reset on reload/session replacement; the compact setting lasts for the current extension instance. Refresh also runs on initialization, agent completion, conversation navigation, compaction, and Explorer focus. External changes are not polled; use `/midnight refresh` when needed.

Customize keys in `~/.pi/agent/keybindings.json`, then `/reload`:

```json
{
  "app.sidebar.toggle": "alt+s",
  "app.explorer.toggle": "alt+e",
  "app.explorer.expand": "right",
  "app.explorer.collapse": "left",
  "app.explorer.preview": "space",
  "app.explorer.folder": "alt+g",
  "app.explorer.parent": "alt+up",
  "app.explorer.project": "alt+home"
}
```

Navigation also follows Pi's `tui.select.*` bindings. An empty array disables a binding. Overlays keep control of input while open.

## Performance and compatibility

- Filesystem/Git work is asynchronous and outside rendering. Reads are bounded and cached, requests coalesce, directories load lazily, and session analysis updates incrementally. There is no filesystem polling, recursive watching, or model call for ordinary UI updates.
- Reload, session replacement, and shutdown cancel pending work, discard late results, close previews, and restore Pi's layout. Project switching uses Pi's session APIs, not `process.chdir()`.
- Midnight preserves the transcript, editor, widgets, and custom footers. Panels are disabled in RPC, JSON, and print modes. Extensions that replace the whole fullscreen layout may conflict.
- Compatibility is pinned to **Pi 1.0.4**. Guarded internal accesses in `src/layout.ts` and `src/session-analysis.ts` need review before supporting another version; unknown layouts are left alone.
- Git/file reads detect ordinary concurrent changes but are not transactional snapshots. OS permissions still apply.

## Development

```powershell
npm ci --ignore-scripts
npm run check
npm test
```

`npm run check` runs Biome and TypeScript validation. `npm test` runs Node's test runner with injected I/O/component checks and real Git in temporary repositories; no provider calls are made. Test fullscreen interaction separately with only the local extension loaded.

See [NOTICE](NOTICE) for extraction provenance and [LICENSE](LICENSE) for the MIT license.
