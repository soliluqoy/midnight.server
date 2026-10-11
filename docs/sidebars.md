# Native Midnight sidebars

Both integrations draw inside the client's terminal interface. No terminal
multiplexer, second pane process, provider request, or transcript scraping is
used to draw the sidebar. The implementations differ: Claude has a public Mods
API, while Codex needs a custom build of its open-source TUI.

## Claude Code

Requires Claude Code 2.1.293+, Midnight v0.3.0+, Node 22.19+, and Git. Use the
[installation or update commands](clients.md#claude-code), then start `claude`
in your working project. For a local development checkout:

```powershell
claude --plugin-dir "C:/zsolusi/midnight.server"
```

Substitute your checkout's path. Load only one copy of Midnight. The mod ships
under `claude-mod/` and is selected only by the Claude manifest; Codex does not
load Claude's hooks. The existing MCP tools are independent of the sidebar.

- `/midnight-sidebar`: open and focus the pane.
- `/midnight-sidebar hide`: close it.
- `/midnight-sidebar refresh`: refresh and focus it.
- In the pane: **1** overview, **2** files, **R** refresh, **Tab/Shift+Tab** move
  between controls, **Enter** activate, **Escape** return to the prompt.
- Claude's **Ctrl+X, X** closes a pane. Its native pane controls also handle
  scrolling, resizing, and focus.

Claude automatically docks the 36-column pane beside the transcript in a wide
fullscreen terminal. An automatic opening waits below 144 columns (110 after
you have opened it yourself). An explicit command can open it in a narrower
terminal, where Claude may place it above the prompt. Those are host layout rules.

The overview shows the host's model, context usage, cost, available rate-limit
windows, Git branch, counts, and up to 40 changed paths. Missing usage stays
missing. Changes are repository-wide, including pre-existing work. Select a
changed path for its unstaged diff, then choose **Staged** for HEAD → index.
**Files** lists one directory at a time, with paged previews and diffs. The shared
reader's path containment, symlink, binary, size, pagination, and concurrent-read
checks still apply. Browsing never switches the working project or submits text.

Git refresh runs at startup, after a turn, on session replacement, and on request.
No polling or recursive watchers are added. Drawing uses cached data; file reads
happen only on navigation. Reads have an eight-second process budget. Closing
the pane stops automatic Git refreshes; reload and session replacement discard
late results. Noninteractive runs do not open a pane or scan Git for it.

The optional external status-line script still works, but may duplicate some
sidebar fields. Keep whichever presentation you prefer.

## Codex CLI fork

Source: [soliluqoy/midnight.codex, midnight/sidebar](https://github.com/soliluqoy/midnight.codex/tree/midnight/sidebar).
Upstream base: `rust-v0.162.1`, commit
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`.

The [Windows x64 prerelease](https://github.com/soliluqoy/midnight.codex/releases/tag/v0.162.1-midnight.1)
contains a ready-to-run development-profile bundle and SHA-256 checksums. Extract
the whole ZIP, keep its executables together, and run from your working project:

```powershell
& "C:/path/to/midnight-codex/midnight-codex.exe" -c tui.fullscreen_transcript=true
```

Follow [the fork's build guide](https://github.com/soliluqoy/midnight.codex/blob/midnight/sidebar/MIDNIGHT.md)
for Rust and Windows C++ prerequisites. From a fork checkout:

```powershell
./scripts/build-midnight.ps1
./midnight-dist/midnight-codex.exe -c tui.fullscreen_transcript=true
```

The script produces the CLI, its six Windows helpers, checksums, and license
notices. Keep the bundle together. Run it from your working project, using your
usual Codex options and authentication, under its separate name/path. Installing
the ordinary Midnight Codex plugin alone does not replace the Codex renderer.

The 36-column sidebar is visible in fullscreen mode at 110 columns or wider:

- **Alt+S** toggles it.
- **Alt+R** refreshes Git.
- Scroll with the mouse wheel over the sidebar.

It shows the current session title, model, project, input/output tokens, context,
branch, Git counts, and changed paths. The transcript and prompt get the
remaining width. Inline mode and narrow windows keep the ordinary layout;
dialogs and overlays retain input ownership. Codex's sidebar is a status view;
use the existing Midnight tools for file previews and diffs.

Git commands run asynchronously through Codex's workspace command runner, so
remote workspaces are queried on their own host. Each read has a three-second
budget and conservative output bounds. Oversized or unavailable status is labeled
unavailable, never clean. Refreshes coalesce; there is no periodic scan. Hiding
the pane or dropping the app cancels pending work, and changing projects detaches
the old cache. Git changes are repository-wide, not session attribution.

Git refresh also depends on the workspace host's command execution and sandbox
setup. During Windows verification, both this build and the stock CLI failed
that setup because an active `node_repl.exe` runtime file was locked. The pane
and its session fields still worked, while Git showed unavailable. Resolve the
host setup error before retrying **Alt+R**; the sidebar keeps the host's sandbox
policy.

## Development

```powershell
npm run check
npm test
npm run test:claude
claude plugin validate --strict .
```

`test:claude` requires the Claude CLI. It runs the host's offline mod test kit
in a temporary plugin directory, separate from the Node test suite. The fork has
its own Rust tests and Windows build workflow. Changes to Pi still require Pi's
normal validation; these integrations do not alter its source.

Contracts: [Claude Mods](https://code.claude.com/docs/en/plugins/mods/overview),
[Claude drawing API](https://code.claude.com/docs/en/plugins/mods/interface),
[Codex open-source components](https://developers.openai.com/blog/codex-as-a-platform).
