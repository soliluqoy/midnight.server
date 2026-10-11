# Midnight for Claude Code and Codex CLI

Midnight provides native plugins for both clients using skills and a local,
read-only MCP server. The Pi extension keeps its existing panels and controls.

| Feature | Pi | Claude Code | Codex CLI |
| --- | --- | --- | --- |
| Sidebar and interactive Explorer | Fullscreen panels | Native mod pane and file views | Native sidebar in the separate Codex fork |
| Git branch and pending changes | Sidebar | Sidebar, tools, optional status line | Fork sidebar, tools, built-in footer |
| Folder browsing, previews, staged/unstaged diffs | Interactive views | Native pane and Midnight tools | Midnight tools |
| Session title, model, context, cost | Sidebar | Pane shows model/context/cost; status line can report title | Fork sidebar shows title/model/context; built-in UI |
| Session-touched pending files | Supported | Repository-wide changes | Repository-wide changes |
| Compact tool rendering, token speed, TTFT | Supported | Not provided by this plugin | Not provided by this plugin |
| Switch working project | Fresh Pi session | Start the client in the other folder | Start the client in the other folder |

Claude Code's Mods API now provides a native pane. Midnight v0.3.0 includes that
mod. Stock Codex plugins still have no documented layout API, so
its native sidebar lives in a separate, pinned CLI fork. See [Native sidebars](sidebars.md)
for setup, supported controls, and differences from Pi.

## Requirements

- Node.js **22.19+** and Git on the client's PATH.
- Claude Code **2.1.293+** for the sidebar mod, or Codex CLI with portable Agent Plugins
  support. Checks used Claude Code **2.1.293** (live pane), **2.1.296** (mod tests),
  and Codex **0.162.1** (the fork's upstream base).
- The plugin's source checkout/cache must be outside `node_modules`: Node does
  not strip TypeScript in dependencies. Install as a CLI plugin, not an npm dependency.

No build, `npm install`, Pi installation, API key, or runtime dependencies are
needed for these native plugins. The server imports only Node built-ins and
Midnight's shared Git/file code. Development checks still use `npm ci` as usual.

## Claude Code

Run in your terminal to install from GitHub:

```powershell
claude plugin marketplace add soliluqoy/midnight.server
claude plugin install midnight@midnight
```

Inside Claude Code, use `/plugin marketplace add soliluqoy/midnight.server` and
`/plugin install midnight@midnight` instead. Start a new session after installing.
Use `/midnight:midnight` for a project overview, or
`/midnight:midnight preview src/index.ts` and `/midnight:midnight diff src/index.ts`.
`/mcp` shows the Midnight server and its four tools.

To pin this release, use `soliluqoy/midnight.server#v0.3.0` as the marketplace
source. To try a local checkout for one session, run from your working project:

```powershell
claude --plugin-dir "C:/zsolusi/midnight.server"
```

Replace that path with your checkout. For a persistent local install, use the
checkout path as the marketplace source in your terminal:

```powershell
claude plugin marketplace add "C:/zsolusi/midnight.server"
claude plugin install midnight@midnight
```

Use one marketplace source at a time. To replace a local marketplace with the
GitHub source, remove it with `claude plugin marketplace remove midnight`, then
run the GitHub install commands above. Removing the marketplace also uninstalls
its plugin; it does not delete your source checkout.

For an unpinned GitHub install, update from your terminal:

```powershell
claude plugin marketplace update midnight
claude plugin update midnight@midnight
```

Start a new session to load the update.

### Optional status line

The optional status-line command needs a stable checkout. If you installed only
the plugin, clone one first with `git clone https://github.com/soliluqoy/midnight.server.git`.
Print a settings fragment using your checkout's actual path:

```powershell
node --experimental-strip-types "C:/zsolusi/midnight.server/src/clients/cli.ts" config claude
```

Merge its `statusLine` property into `~/.claude/settings.json` or your project
settings. Review any existing `statusLine` before replacing it. The command
prints configuration only; it never edits settings. Keep the checkout in place
because the generated command refers to its absolute location. The encoded
loader protects paths containing spaces, quotes, dollar signs and other shell
characters; it imports the local entry point.

The status line shows project, branch, client-supplied title/model, Git counts,
context percentage, reported input/output tokens, and estimated cost when
available. Token labels follow Claude's payload: context input and the latest
output count, not independently accumulated session totals. Missing data remains
unavailable. No extra title requests, timing estimates, transcript scans, polling,
or interval refresh are added. Claude drives refreshes; Git work has a 1.5-second
budget and may show unavailable in large or slow repositories.

Plugin settings cannot set the main `statusLine` automatically. Remove that
property to stop using the script, and `/plugin uninstall midnight@midnight` to
remove the plugin. Remove the status-line setting before deleting its checkout.

## Codex CLI

Add the GitHub marketplace from your terminal, then install:

```powershell
codex plugin marketplace add soliluqoy/midnight.server
codex plugin add midnight@midnight
```

Start a new Codex session in your project. Select `midnight:midnight` from the `$`
skill picker, or ask Midnight to show status, browse a folder, preview a file, or
inspect its diff. `/mcp` lists the bundled tools.

To pin this release, append `--ref v0.3.0` to the marketplace command. For local
development, replace `soliluqoy/midnight.server` with your checkout path, such as
`"C:/zsolusi/midnight.server"`. Use one marketplace source at a time; remove an
existing source with `codex plugin marketplace remove midnight` before adding
its replacement, then run `codex plugin add midnight@midnight` again.

To refresh an unpinned GitHub marketplace and update the installed plugin:

```powershell
codex plugin marketplace upgrade midnight
codex plugin add midnight@midnight
```

Start a new session to load the update.

Use Codex's `/statusline` picker for model, context, Git and other built-in footer
fields. To print a starter footer configuration and an optional standalone MCP
configuration:

```powershell
node --experimental-strip-types "C:/zsolusi/midnight.server/src/clients/cli.ts" config codex
```

Merge only the desired settings into `~/.codex/config.toml`; do not duplicate an
existing `[tui]` table. When the plugin is installed, omit the generated
`[mcp_servers.midnight]` table to avoid loading two servers. The standalone MCP
configuration is a fallback for clients without plugin installation; it provides
the tools but not the bundled skill. Remove an installed plugin with
`codex plugin remove midnight@midnight`.

## Tool behavior

| Tool | Input | Result |
| --- | --- | --- |
| `midnight_status` | Absolute `cwd` | Repository root, branch, counts, changed paths |
| `midnight_list` | `cwd`, optional `path` | One directory, naturally sorted, directories first |
| `midnight_preview` | `cwd`, `path` | UTF-8 file lines with source line numbers |
| `midnight_diff` | `cwd`, `path`, optional `layer` | Staged or unstaged patch with display line numbers |

All accept zero-based `offset` and `limit` (1–500, default 100). `nextOffset`
indicates another page; `null` means the result is complete. Status paths are
relative to the returned repository root, including when `cwd` is a subdirectory.
Other view paths are relative to `cwd`. Browsing another directory requires an
explicit `cwd`; it does not change the client's working project.

Git reports current changes in the repository, including pre-existing work.
It does not attribute edits to the conversation. Diffs default to **unstaged**
(index → disk); request **staged** for HEAD → index. Before the first commit the
staged comparison uses the empty tree. Untracked text compares with empty content.
Renames include both endpoints. Conflicts, ignored files without a baseline,
submodules, unavailable Git and changing files produce explicit explanations.
Binary/mode changes retain Git's patch metadata rather than invented line counts.

Preview reads are bounded to 1 MiB and 20,000 lines and refuse binary, symlink and
special files. Patch output is bounded to 1 MiB; each page contains at most
48 KiB of entries before protocol encoding. An individual line that cannot fit is
reported as unavailable. Terminal control sequences are removed from displayed
content. File and index stamps detect ordinary concurrent changes, but reads are
not transactional snapshots.

The MCP server runs locally over stdio, with four concurrent reads at most,
bounded input, timeouts, cancellation and shutdown cleanup. There is no network
listener or provider call. Like other local MCP servers, it runs with your OS
permissions: `cwd` is explicit per call, not an OS sandbox. Paths outside it or
directory links escaping it are rejected. Use the client's normal tool approval
controls. Calling tools through an assistant can still consume that client's
normal model tokens.

For direct, provider-free use:

```powershell
node --experimental-strip-types src/clients/cli.ts status
node --experimental-strip-types src/clients/cli.ts list src --limit 25
node --experimental-strip-types src/clients/cli.ts preview README.md
node --experimental-strip-types src/clients/cli.ts diff README.md --layer staged
```

These print JSON and default to the shell's current directory. Pass `--cwd` to
choose a different project. `--help` lists commands.

## References

Integration contracts: [Claude installation and updates](https://code.claude.com/docs/en/discover-plugins),
[Claude native panes](https://code.claude.com/docs/en/plugins/mods/interface),
[Claude plugin components](https://code.claude.com/docs/en/plugins/components),
[Claude status line](https://code.claude.com/docs/en/statusline),
[Codex plugin packaging](https://developers.openai.com/plugins/build/plugins),
[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[MCP stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).
