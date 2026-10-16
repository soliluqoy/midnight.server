# midnight.server

A Pi-only extension with native context management and Git checkpoints, a session sidebar and file explorer, compact tool display, automatic titles, token-speed stats, clarification questions, and a local evidence ledger. Local log triage and bundled Trim-1 line selection work without a helper key. Browser access and chat-helper uploads are opt-in.

Requires **Pi 1.2.0**, **Node.js 22.19+**, and Git on PATH. Panels require fullscreen TUI mode. There is no standalone server or build step; Trim-1 ships as WebAssembly. Claude Code and Codex CLI integrations are not included.

**Release status:** [v0.5.0-beta.1](https://github.com/soliluqoy/midnight.server/releases/tag/v0.5.0-beta.1) is a native-suite prerelease, not stable. It does **not** contain the newer development-branch log helper, picker, or bundled Trim-1 described here. [v0.4.0](https://github.com/soliluqoy/midnight.server/releases/tag/v0.4.0) is the previous stable release. Fullscreen interaction and an isolated fresh install remain unverified release gates; see the [release notes](docs/releases/v0.5.0-beta.1.md).

![Midnight's file explorer, session sidebar, and folder menu](docs/images/midnight-preview.jpg)

## Install

For the pinned prerelease:

```powershell
pi install git:github.com/soliluqoy/midnight.server@v0.5.0-beta.1
```

For the newer, **moving development branch** (including the log helper and Trim-1):

```powershell
pi install git:github.com/soliluqoy/midnight.server@main
```

Restart Pi or run `/reload`, then select fullscreen TUI mode in `/settings`. Installing a different ref from the same repository replaces its Pi package declaration; a pinned tag does not update itself to `main`. Check `pi list` and load **only one** Midnight source. To run a local checkout instead, use `pi --extension . --tui-mode fullscreen` from the repository root, not `src/index.ts` (the package directory also exposes the theme). [Release assets and checksums](https://github.com/soliluqoy/midnight.server/releases) are available for the prerelease.

## First steps

| Action | How |
| --- | --- |
| Toggle the session sidebar / Explorer | Alt+S / Alt+E |
| Open the Explorer folder menu | Alt+G while Explorer is focused |
| Navigate / edit / preview / insert a file reference | Arrows and PageUp/PageDown / Space / Right or Alt+P / Enter |
| Expand tool output | Ctrl+O or click its row |
| Inspect the suite and native-service ownership | `/midnight status` or `/midnight doctor` |
| View context / open checkpoint picker | `/midnight context` / `/midnight rewind` |
| Refresh Git and file state | `/midnight refresh` |

Explorer also supports Left/Right to collapse/expand, Alt+Up for the parent, Alt+Home for the project, and Escape to close a preview. Space now opens the selected file in bundled Micro (it previously opened preview); Right on a file or Alt+P previews without editing. In Micro, Ctrl+S saves and Ctrl+Q quits; Micro handles unsaved-change prompts. Click to select and double-click to insert a file; typing outside navigation returns to the prompt. Sidebar and Explorer start in `auto` mode (visible at 110 and 150 columns respectively) and hide when too narrow. Click the sidebar model name to select a model. The bundled **midnight** dark theme is chosen only when Pi has no explicit theme preference; change it in `/settings` → **Theme**. Other selected themes keep their own colors.

## Native context and checkpoints

**Context management is on by default.** It keeps saved Pi history separate from editable model-facing context and a validated `LIVE_CONTEXT.md` mirror. Editing the mirror does not rewrite the transcript or grant system-role authority to custom labels. `/midnight context` shows usage, settings, edits, and the mirror path. `/midnight context compact [instructions]` asks the current coding model to compact live context (**normal provider charges apply**); Pi's `/compact` is a separate transcript operation. `midnight_context_annotate` and `midnight_context_recall` retain or recover bounded exact sources. Budget estimates are not provider-observed usage or a fit guarantee; rejected mirror edits leave effective context unchanged. Saved history and temporary mirror/overflow files may retain sensitive material.

The default context budget is 150,000 tokens (clamped to a smaller known model window), with a 2,048-token generation reserve and reminders at 50%, 75%, 90%, then budget minus reserve. The overflow guard withholds older eligible tool results while keeping recoverable source text. Native automatic compaction is paused during ordinary guarded pressure; manual and provider-overflow recovery remain available. Configure branch-local policy with `/midnight context config` or supported `PI_CLM_*` environment defaults; `/midnight context` shows effective values. Invalid configuration disables the service with a diagnostic. `MIDNIGHT_TRIM=off` disables new Trim-1 processing.

**Checkpoints are on by default when a Git worktree is available.** They capture observed pending work without initializing Git, committing your work, or moving HEAD. `/midnight rewind` offers files and conversation, files only, or conversation only; conversation navigation **never restores files by itself**. File restore requires a read-only preview and confirmation, preserves staged and unstaged layers and unrelated paths, refuses a changed HEAD/branch, and does not run blanket `git clean` or reset HEAD. `/midnight checkpoints capture`, `redo`, and `recover` offer manual capture, a confirmed pre-restore redo, and explicit recovery from an interrupted restore; **there is no automatic rollback**. `legacy` and `import` inspect/import old pi-rewind metadata without restoring files; imported checkpoints support files-only restores.

Checkpoint coverage is not an authorship claim or a full backup: pre-existing/external changes may be captured, and excluded, sensitive-name, unreadable, oversized, symlink or submodule paths can leave gaps. Limits are 10,000 candidate paths, 10 MiB per file, and 64 MiB of raw reads. Preview exclusions and unavailable coverage before restoring. A recovery checkpoint and journal precede disk changes; avoid concurrent edits or Git operations during restore. Native refs are retained under `refs/midnight/checkpoints/` (50 ordinary snapshots per session); **Git objects can outlive refs and may contain secrets**.

**Migration:** Do not run two context or rewind engines. Midnight detects external CLM/rewind ownership at startup and pauses the overlapping native service; `/midnight status` explains this. Remove or disable only the external entries you intend to replace, then reload. Familiar `/clm`, `/clm-compact`, and `/rewind` aliases are registered only when ownership is confirmed and names are free. Midnight never uninstalls packages or rewrites user configuration. `/midnight config context|checkpoints on|off` saves branch-local preferences; reload or change session/branch to activate them. `MIDNIGHT_CONTEXT=off` and `MIDNIGHT_CHECKPOINTS=off` set new-session defaults. Legacy context records remain readable; checkpoint import is explicit.

## Panels and everyday tools

The **sidebar** shows the session title, Git state, context pressure, tokens/cost, model/thinking level, pending session files, and triage/evidence status. With the sidebar visible, duplicate session/model/usage footer fields are hidden; cache stats and other extension statuses remain. Midnight's redundant CLM size/revision footer status is hidden in all interactive layouts. Context details remain in the sidebar and `/midnight context`; hiding the sidebar restores Pi's normal footer. Explorer hides the footer path only when it repeats the working directory.

**SESSION FILES** shows current pending Git changes for paths touched by successful `edit`/`write` calls on the active conversation branch. It is **not** a session-authored diff: pre-existing or external edits may be included; shell-only paths not touched by those tools are not listed. Staged and unstaged changes remain separate. Conflicts, binary/unreadable states and historical **RECORDED FILES** do not receive invented clean counts. Click a row for a bounded read-only diff. Refreshes do not poll external changes; use `/midnight refresh` when needed.

Explorer browses hidden and ignored files lazily. Its read-only preview rejects files over 1 MiB, invalid UTF-8 and detected NUL content. Editing also requires a regular, writable UTF-8 file of at most 1 MiB; symlinks and unsupported files are refused without changing them. Micro edits the selected file directly, including when browsing outside the project: confirm the path before pressing Space. In Windows Terminal, Space requests a separate Micro window while Pi remains usable in its original window; after saving, return to Pi and run `/midnight refresh` to update Explorer/Git state. The new window uses Windows Terminal's own size and placement settings; automatic focus return is not guaranteed. On macOS, Linux, or Windows outside Windows Terminal, Micro still temporarily takes over Pi's terminal, then redraws and returns focus to Explorer. External changes may conflict with edits made in Micro; Micro owns saving and unsaved-change prompts. Manual Micro edits update Git state on return but are not attributed as successful agent `edit`/`write` calls in SESSION FILES. The six bundled executables cover Windows, macOS and Linux on x64/ARM64; other targets receive an unavailable message. No runtime download or separate Micro installation is required. **Browsing does not change the agent's working project.** Use Alt+G or `/midnight project <path>` to request an explicit switch: confirmation creates a fresh persistent session and carries only an unsent draft, not conversation history. Switching is blocked while work/compaction/queued messages remain and unavailable with `--no-session`.

Compact tool rows are display-only; Ctrl+O expands Pi's original output. `/midnight compact off` restores ordinary tool rendering (and visible inline workflow text), without changing saved or model-facing tool results. Automatic titles preserve manual `/name` titles; `/midnight title off` disables requests, which **may incur provider charges**. The footer's tokens/sec, response duration and time-to-first-token measurements make no extra requests.

The `midnight_question` tool asks one focused question with alternatives or text input. Escape/blank input cancels; **cancellation is not approval or a default choice**. It is not a command-permission gate or sandbox. Questions and answers persist in the conversation and reach the active coding model—do not enter secrets. Print/JSON runs cannot open its dialog; RPC needs a compatible extension UI client.

## Local evidence ledger (development)

`midnight_evidence` records branch-aware **evidence** (source observations), **claims** (interpretations with supporting evidence IDs), and **gaps** (unanswered questions). It is local bookkeeping, **not independent verification**. Passive receipts for structured shell exit codes and log-triage results are observations, not claim support by themselves; no command text or log body is copied into a receipt. The ledger does not inject prompts, invoke helper uploads, or create conclusions automatically.

For substantial investigations, invoke the explicit-only `/skill:midnight-evidence <question>`; routine edits need no ledger workflow. For example:

```json
{ "action": "add", "kind": "evidence", "text": "Observed behavior", "path": "src/index.ts", "startLine": 1, "endLine": 5 }
{ "action": "add", "kind": "claim", "text": "A qualified conclusion", "refs": ["<evidence-id>"], "applicability": "current" }
{ "action": "audit", "selected": ["<claim-id>"] }
```

Select actual relevant source lines, not the example range. `list`/`show` inspect records; `supersedes` corrects a record, `retract` requires a reason, and resolving a gap requires evidence. `check` rechecks tracked sources. Current claims are conservatively marked for review after observed shell/edit/write completion, session load or navigation; changed/unavailable sources propagate review. Review never clears automatically, even when a file is restored. The read-only, selected-claim `audit` reports recorded support/concern/freshness limitations and paginated findings; **no findings does not mean verified**. It cannot judge semantic support or unrecorded gaps.

A fresh **`/new` session** with the development extension explicitly initializes v3 semantics: gap `concerns`, resolution `resolvedBy`, and structured `reviewReasons`/`reviewOverflow`. Startup, reload, resume, fork, or an empty ledger do not upgrade an old session. Existing v1/v2 sessions retain their historical semantics and hashes; do not invent relationships or precise review causes for legacy data. **Never open a v2-migrated branch with a v1 writer, or a v3 branch with a v1/v2-only writer**, including for passive observations. There is no automatic upgrade or repair. See [unreleased compatibility notes](docs/releases/unreleased.md).

The 512-record branch limit stops new captures rather than evicting history. If capacity must be recovered, preview a selected carry set with `midnight_evidence` `action: "preview"` or `/midnight evidence preview <ids...>`; dependencies carry automatically. Inspect omitted/review pages and warnings before **you** run `/midnight evidence commit <token>` in an idle interactive TUI and confirm. `selected: []` / `preview --empty` deliberately carries nothing. Omitted entries remain historical, not resolved. Keep the preview's predecessor locator for read-only `archive` lookup; historical entries are not fresh evidence. `/midnight evidence recover` confirms a replay after an uncertain append; it never retries or undoes the write. Neither commit nor recovery is model-callable or available in print/JSON/RPC. Manual fullscreen/reload compatibility is still an unverified release gate.

File evidence is an explicit local read of a project-contained UTF-8 file up to 1 MiB, with a hash and an excerpt up to 100 lines / 4,000 UTF-16 code units. Symlinks must stay inside the project; known sensitive paths are refused, **not** all secrets detected. Excerpts and statements persist in Pi session history and reach the active model; retraction is not deletion. Avoid secrets in evidence or claims. File hashes, receipts, and exit codes do not prove correctness. No reasoning-quality or token/cost benefit has been measured.

## Log triage and optional helper (development)

`midnight_log_triage` extracts line-numbered diagnostic evidence and SHA-256 snapshots from a UTF-8 `.log`, `.txt`, or `.out` file **inside the working project**, up to 1 MiB. It never runs commands or infers a build exit code: record the actual exit code separately. For example:

```powershell
New-Item -ItemType Directory -Force .artifacts | Out-Null
npm test 2>&1 | Out-File -Encoding utf8 .artifacts/test-output.log
$testExitCode = $LASTEXITCODE
```

Ask Pi to use `midnight_log_triage` on `.artifacts/test-output.log` and inspect the original evidence. `mode: "auto"` uses local extraction for small/recognized output and otherwise uses an explicitly selected **and authorized** chat helper. `mode: "local"` never uploads; `mode: "remote"` bypasses local gates, **not** consent, limits or successful caching. Omit `startLine` for failure-focused selection; an explicit window is unranked. The helper sees at most **400 complete lines / 24 KiB**, after best-effort redaction. Known sensitive paths and escaping symlinks are rejected. For structured reports such as JUnit, prefer a dedicated local parser. Unknown output is not clean output, and triage's `exitCode` is always `null`.

**Uploads are off by default.** To enable them interactively, run `/midnight triage model`, choose a configured physical Pi **chat** model, then `/midnight triage on` and confirm sharing selected log text with its provider. `/midnight triage models` lists choices; `/midnight triage model provider/model-id` selects one explicitly. Selection alone does not enable uploads or change the coding model. Coding-model access may not authorize helper access or billing; unavailable helpers return local evidence rather than falling back to another model. `/midnight triage off` disables uploads but leaves local triage available.

For print/JSON/RPC use, explicitly set `MIDNIGHT_TRIAGE_MODEL` and pass `--midnight-triage` (scoped to the starting project), or set `MIDNIGHT_TRIAGE_ENABLED=1` to authorize uploads across projects/sessions. `MIDNIGHT_TRIAGE_MAX_REQUESTS` defaults to 20 attempts per session start/reload; `MIDNIGHT_TRIAGE_TIMEOUT_MS` defaults to 15000. Interactive consent resets on reload/session replacement; changing the model requires fresh consent. One uncached helper assessment makes one request, with retries disabled. `/midnight triage status` distinguishes local, remote and cached work, attempts, timing, and incomplete usage. Catalog cost is an **estimate**, not a billing receipt; unknown usage or zero catalog price is not proof of a free call. Additional live/provider validation and paid benchmarks need separate approval, unlike ordinary authorized use.

Redaction is best effort: **do not upload secrets or confidential logs outside your authorization**. Original snapshots in OS temp under `midnight-log-triage-*` can contain secrets and are not automatically deleted on shutdown; delete them when no longer needed. Summaries and logs are untrusted evidence, not instructions. No accuracy, latency or savings claim is made without measurement.

**Trim-1** is a bundled local line ranker, on by default for eligible large triage logs and, under native context ownership, eligible complete log tool outputs. It does not summarize, upload, change saved results, or trim source reads/user messages. Selection can omit important lines; snapshots and hashes support recovery. Disable new processing with `MIDNIGHT_TRIM=off`. See [eligibility, provenance and rebuild details](docs/trim-1.md).

## Optional browser and portable skills

Browser access is **off by default**. With the optional `chrome-devtools-mcp` dependency installed, start your own dedicated Chrome debugging profile, then explicitly run `/midnight browser connect http://127.0.0.1:9222` in an idle interactive session and confirm. Only loopback HTTP endpoints without credentials/path/query/fragment are accepted. Midnight does not launch Chrome or select a personal profile. Tools may access signed-in pages: use a dedicated profile and respect site permissions. `/midnight browser status` reports registration, **not connection health** (inspect Pi's `/mcp`); `disconnect` removes only Midnight's registration. An existing user MCP entry takes precedence.

Bundled workflow skills are **midnight-context**, **midnight-checkpoints**, and explicit-only **midnight-evidence**. They reuse Pi's host models, authentication and tools rather than bundling a second runtime.

## Commands and compatibility

| Command | Purpose |
| --- | --- |
| `/midnight status\|doctor`; `/midnight config context\|checkpoints on\|off` | Inspect ownership/diagnostics; save service preferences |
| `/midnight context [status\|config\|path\|on\|off\|reset]`; `context compact [instructions]` | Context viewer, policy, projection, compaction |
| `/midnight rewind`; `/midnight checkpoints [status\|capture\|redo\|recover\|legacy\|import]` | Picker, snapshots, restore and migration |
| `/midnight sidebar\|explorer [auto\|always\|hidden]`; `/midnight explorer go [path]\|parent\|project` | Panels and browsing |
| `/midnight project [path]`; `/midnight refresh` | Confirmed project switch; refresh file/Git state |
| `/midnight compact on\|off`; `/midnight title auto\|off` | Display and automatic title controls |
| `/midnight evidence status\|check\|show [id]`; `preview <ids...>\|--empty`; `commit <token>`; `recover` | Ledger inspection and user-confirmed recovery |
| `/midnight triage model [provider/model-id]`; `models\|on\|off\|status` | Helper selection, consent and usage |
| `/midnight browser status\|disconnect\|connect <url>` | Optional browser registration |

Panel modes reset on reload/session replacement. Keybindings can be customized in `~/.pi/agent/keybindings.json`; navigation follows Pi's `tui.select.*` bindings, and overlays keep input ownership. Panels are disabled in print/JSON/RPC; extensions replacing the fullscreen layout can conflict. File/Git work is asynchronous, bounded and not polled; shutdown/reload/session replacement cancel pending work and discard stale results. Pi library peers are pinned to **1.2.0**; other versions need compatibility review and fullscreen testing, not just a successful smoke test.

## Development

```powershell
npm ci --ignore-scripts
npm run check
npm test
```

`check` runs Biome and TypeScript; `npm test` runs the focused Micro integration tests. Neither replaces a fullscreen keyboard/focus test or cross-platform binary launch verification. For manual UI testing, load **only** the local package with `pi --extension . --tui-mode fullscreen` and check keyboard, mouse, resize, reload, and an isolated installation before release. The check does not establish those gates. See [NOTICE](NOTICE), [native source provenance](docs/native-suite-provenance.json), [upstream licenses](licenses), and [LICENSE](LICENSE).
