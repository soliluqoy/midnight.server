# midnight.server

A native **Pi suite** with context management, safe checkpoints/rewind, session sidebar and file explorer, a blue theme, compact tool output, automatic titles, token-speed stats, clarification questions and a local evidence ledger. Local log triage and bundled **Trim-1** line selection are included and enabled by default; browser access and chat-helper uploads are explicit opt-in integrations. No separate pi-clm or pi-rewind installation is needed.

Requires **Pi 1.2.0** (matching the current managed Pi installation), **Node.js 22.19+**, and Git on PATH. Side panels need fullscreen mode. There is no install-time build step or standalone server; Trim-1 ships as WebAssembly and needs no Go installation. Core services use the pinned Pi libraries; the browser server is an optional npm dependency.

[**v0.5.0-beta.1**](https://github.com/soliluqoy/midnight.server/releases/tag/v0.5.0-beta.1) is the native-suite **prerelease**, not a stable release. Fullscreen interaction and an isolated fresh installation remain unverified release gates; see the [release notes](docs/releases/v0.5.0-beta.1.md). [v0.4.0](https://github.com/soliluqoy/midnight.server/releases/tag/v0.4.0) remains the previous stable release and predates these native additions. Midnight is Pi-only; Claude Code and Codex CLI integrations are not included.

![Midnight's file explorer, session sidebar, and folder menu](docs/images/midnight-preview.jpg)

## Install

Install the published native-suite prerelease with a pinned tag:

```powershell
pi install git:github.com/soliluqoy/midnight.server@v0.5.0-beta.1
```

That published tag does **not** include the newer local-first chat-model triage, helper picker, or bundled Trim-1 described below. To try those changes from the development branch instead:

```powershell
pi install git:github.com/soliluqoy/midnight.server@main
```

`main` is a moving development branch, not a pinned release. Installing the same repository with a different ref replaces its Pi package declaration; check `pi list` and keep only one Midnight source. Updating a tag-pinned install does not move it to a newer tag or to `main`.

Restart Pi or run `/reload`, then choose fullscreen TUI mode in `/settings`. Source archives, a packaged `.tgz`, and checksums for the published prerelease are available from [GitHub Releases](https://github.com/soliluqoy/midnight.server/releases).

To try a local checkout:

```powershell
git clone https://github.com/soliluqoy/midnight.server.git
cd midnight.server
pi --extension . --tui-mode fullscreen
```

**Load only one Midnight source.** For local development, use the checkout instead of the Git-installed copy. Check `pi list`; duplicate copies compete for panels and shortcuts.

## Native ownership and migration

A fresh single-package installation enables native context management and Git checkpoints automatically. Existing panel, title, question and evidence behavior is preserved. Local log triage needs no helper key; optional chat-helper uploads require model selection and explicit consent. Browser access requires an explicit connection.

**Do not run two context or rewind engines.** At session startup Midnight checks public runtime command/tool registration. If external CLM/live-context or rewind ownership is detected, the overlapping native service pauses and `/midnight status` explains why. Canonical `/midnight-context`, `/midnight-context-compact` and `/midnight-rewind` controls remain diagnostic/guarded; familiar `/clm`, `/clm-compact` and `/rewind` aliases are registered only when native ownership is confirmed and names are free.

For an existing setup, inspect `pi list`, remove or disable only the external CLM/rewind entries you intend to replace, then reload. Midnight never uninstalls packages or rewrites user configuration. Legacy context session records remain readable; legacy checkpoint import is explicit. Keep only one Midnight source loaded.

`/midnight config context|checkpoints on|off` saves a versioned branch-local service preference; reload or switch session/branch to activate it. For new-session defaults, `MIDNIGHT_CONTEXT=off` or `MIDNIGHT_CHECKPOINTS=off` disables the corresponding native engine. Context policy remains configurable through `/midnight context config` and supported CLM environment variables. No project setting silently authorizes uploads.

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

### Native context management

Context management is **included and on by default**. No separate pi-clm installation is needed. Midnight maintains three distinct layers: the immutable saved Pi transcript, effective model-facing context, and a validated editable `LIVE_CONTEXT.md` mirror. Editing the mirror does not rewrite saved conversation history or turn new role labels into provider system instructions.

`/midnight context` opens the overview, input, edits and settings viewer. Use `status` for effective settings, `path` for the mirror, `on|off` to control projection, and `config <setting> <value>` for branch-local policy. `/midnight context compact [instructions]` asks the current coding model to compact its live context; **normal provider charges apply**. It is different from `/midnight compact on|off` (tool rendering) and Pi's `/compact` (transcript summarization).

| Policy | Default |
| --- | --- |
| Context budget | 150,000 tokens, clamped to a smaller known model window |
| Generation reserve | 2,048 tokens |
| Budget reminders | 50%, 75%, 90%, then budget minus reserve |
| Overflow guard | Withhold oldest eligible tool results; retain recoverable source text |
| Pi automatic compaction | `auto`: paused while the guard handles ordinary pressure; manual/provider-overflow recovery remains available |
| Trim-1 line selection | On for eligible large log tool outputs; local, bounded, recoverable |
| Observation cap / one-tool restriction / size trailer | Off |
| Steering | Bundled portable brief; existing environment/session overrides remain supported |

Mirror rendering canonicalizes each message once per render and reuses those bytes for the baseline digest and block ID. It retains no cross-request hash cache; cloned or mutated inputs are hashed afresh, with unchanged document framing and source references.

Budget readings distinguish estimated next-request size from provider-reported previous usage. They are not guarantees that every provider request fits. Mirror edits validate framing/revision and normalize tool-call/result groups; rejected edits do not replace effective context. Context history, revision diffs and branch-local projections survive reload/resume through Pi session entries.

Use **`midnight_context_annotate`** to pin bounded exact text, keep an outstanding continuity obligation, or archive recall-only provenance. **`midnight_context_recall`** returns bounded exact sources with hash validation. Existing CLM settings, projection and annotation records remain readable; native tools have canonical Midnight names, not competing legacy tool aliases. Neither annotations nor context edits authorize secret storage. Saved history and local mirror/overflow files can retain sensitive material; removing a mirror block is not deletion from history.

Supported environment defaults remain `PI_CLM_BUDGET`, `PI_CLM_RESERVE`, `PI_CLM_REMIND_AT`, `PI_CLM_OVERFLOW`, `PI_CLM_NATIVE_COMPACTION`, `PI_CLM_OBSERVATION_CAP`, `PI_CLM_STEERING`, `PI_CLM_ESTIMATE_FACTOR`, `PI_CLM_ONE_TOOL_PER_TURN`, `PI_CLM_SIZE_TRAILER` and `PI_CLM_COMPACT_PROMPT`. Use the context settings viewer for descriptions and effective values. Invalid configuration disables the native context service with a diagnostic rather than silently choosing a different policy.

### Bundled Trim-1

**Trim-1 runs locally inside Midnight by default**, with its model and WebAssembly runtime included in the package. No separate executable, Go installation, API key, provider request, or runtime download is needed. It selects existing lines rather than generating summaries; selection can omit useful evidence and is not a diagnosis or verification.

- **Log triage:** after validation and redaction, large logs can be ranked against an optional `query` (default: build/test failure evidence). Existing diagnostic/context and final-output priorities, source snapshots, hashes, and the 400-line / 24 KiB selection limits remain. Explicit `startLine` windows are not ranked. Results report local Trim-1 use, skips or fallback when ranking is attempted.
- **Model-facing context:** when native context ownership is active, eligible complete log reads and exact allowlisted build/test commands can receive balanced line selection. Known diagnostic lines with nearby context and the tail are protected. Source-file reads, instructions, explicit read windows, already truncated output, structured/mixed results, codemode aggregates, and user/system messages are not trimmed. Saved tool results and the original transcript are unchanged. Excerpts link to an exact temporary tool-output snapshot with its hash; use `read` with `offset`/`limit` for omitted context.
- **Bounds and fallback:** a lazy reusable worker handles at most 1 MiB / 20,000 lines per input, with a two-second deadline. Errors, missing assets or ineffective cuts leave original context intact or use existing triage selection. Decisions are reused rather than reranking old outputs against every new question. Existing mirror edits, annotations, overflow withholding and Pi compaction remain available.

Set **`MIDNIGHT_TRIM=off`** before starting Pi to disable new Trim-1 processing in both paths. This is independent of helper-upload consent and does not undo saved context edits. `/midnight triage status` reports whether the bundled ranker is enabled. Context trimming also stops when native context management is disabled or another extension owns it.

**Privacy:** processing stays local, but recovery snapshots can contain secrets. Context snapshots share the mirror's temporary lifetime and are removed on its cleanup; original saved results remain in session history. Triage snapshots retain their existing independent retention policy below. There are no new background uploads. No reasoning-quality, token, latency or cost benefit is claimed without measurement. See [implementation, eligibility, provenance and rebuild details](docs/trim-1.md).

### Native checkpoints and rewind

Checkpoints are **included and on by default when a Git worktree is available**; no separate pi-rewind installation is needed. Midnight records startup/manual snapshots and changed pending state after observed mutating tool activity, including nested codemode activity. It never initializes Git silently. Captures store raw covered file bytes and distinct index/worktree trees in local Git objects without committing your work or moving HEAD.

Checkpoint history is loaded and validated in bounded Git batches rather than launching several Git processes per snapshot. Restore targets are reloaded before use; there is no persistent validation cache. Unchanged ordinary captures reuse an existing retained snapshot before writing new commits or refs, including comparisons of scope, coverage and exclusions. Recovery backups are always fresh. Shell/codemode activity still triggers conservative file verification—even for a read-only command—rather than guessing which commands can change files.

Capture serially inspects paths in sorted order. Unknown raw blobs are spooled from verified buffers into exclusively created mode-0600 temporary files (at most 64 MiB across at most 10,000 files, excluding filesystem overhead), then written by one `git hash-object -w --no-filters --stdin-paths` process. Known blobs need no blob-write process. Every returned object ID must match its locally computed hash in order before temporary-index updates; failures or cancellation reject capture. Temporary files are removed through capture cleanup, and Git never rereads mutable worktree paths for this batch.

`/midnight rewind` opens the checkpoint picker. Choose **files and conversation**, **files only**, or **conversation only**. Conversation navigation alone never restores files. File restoration requires a scrollable read-only preview and explicit confirmation; it preserves unrelated paths and staged/unstaged layers, refuses changed HEAD/branch, and never uses blanket `git clean` or resets HEAD. After a file restore, Midnight refreshes evidence and panel/file state; tree navigation rebuilds branch-specific context.

- `/midnight checkpoints capture`: manual capture; unchanged snapshots are deduplicated.
- `/midnight checkpoints redo`: restore the pre-restore file state through the same preview/confirmation flow. Redo metadata survives reload and tree navigation within the session.
- `/midnight checkpoints recover`: explicitly preview recovery from a leftover failure journal. There is **no automatic rollback**.
- `/midnight checkpoints legacy` and `import`: inspect/import legacy pi-rewind 0.5.0 commit metadata for this session. Import adds native refs/session metadata only; it never restores files or deletes old refs. Legacy conversation mapping is unavailable, so imported checkpoints support files-only restores.

**Scope and coverage matter:** restore candidates are observed session paths and differences in pending state—not proof of exact authorship. Pre-existing or external edits can be included. Captures cover at most 10,000 candidate paths, 10 MiB per raw file and 64 MiB total raw reads. Known sensitive names, excluded directories, symlinks/submodules, oversized or unreadable paths are excluded or make the operation unavailable; missing coverage is never reported as clean. Snapshot exclusions are shown in the restore preview.

A mandatory recovery checkpoint and journal precede disk changes. Competing checkpoint/index operations are locked; ordinary concurrent changes are rechecked before writing. An interrupted or partially failed operation leaves a journal and recovery data rather than claiming success. Avoid concurrent edits/Git operations during a confirmed restore: these checks are not an adversarial filesystem transaction or a sandbox.

Native refs live under `refs/midnight/checkpoints/<session-hash>/`. Retention keeps 50 ordinary snapshots per session and does not prune other sessions or recovery snapshots. **Git objects may persist after refs are removed; exclusions are not a guarantee that snapshots contain no secrets.** Git ignore/exclusions also mean checkpoints are not a full-system backup. The old double-Escape interception is not installed; Pi retains ownership of its tree/editor keys.

### Optional browser adapter and portable skills

The optional **chrome-devtools-mcp 1.10.1** dependency supplies the browser server; a separate Pi browser extension is not required. Browser access is **off by default**. Start your own dedicated Chrome debugging profile, then explicitly run:

```text
/midnight browser connect http://127.0.0.1:9222
```

Connection requires an idle interactive session and confirmation. Only loopback HTTP endpoints without credentials/path/query/fragment are accepted. Midnight does not launch/download Chrome or select a personal profile. The server is registered with deferred tools, usage telemetry and CrUX disabled, and best-effort network-header redaction. Browser tools can access signed-in pages: use a dedicated profile and follow site permissions.

`/midnight browser status` reports registration, **not verified connection health**; inspect Pi's `/mcp` for that. `disconnect` removes Midnight's registration, not user-configured servers. Session replacement/reload/shutdown clears the native registration. An existing user MCP entry named `chrome_devtools` takes precedence; Midnight never rewrites `mcp.json`. If optional dependencies were omitted during installation, browser connection reports unavailable while the core suite still works.

Three original portable workflow skills ship with the package: **midnight-context**, **midnight-checkpoints**, and explicit-only **midnight-evidence** (`/skill:midnight-evidence`). Personal desktop/document/research connector skills are not copied or advertised as operational. Pi's own models, codemode, authentication and other host capabilities are reused, not bundled as another Pi runtime.

### Session sidebar

Starts with **MIDNIGHT / SESSION** and the session title, followed by Git status, a thin context meter with a right-aligned percentage, token totals, cost, model/thinking level, and session-touched files. Context pressure turns amber above 70% and red above 90%; unknown usage is never drawn as an empty meter.

While the sidebar is visible, repeated session/model/usage fields disappear from Pi's footer. Cache stats and extension statuses remain. Hiding the sidebar restores the normal footer. Explorer hides the footer's directory path only when it shows the same working directory.

### Session files and diffs

**SESSION FILES** lists paths touched by successful `edit`/`write` calls on the current conversation branch that still have pending changes. Restoring, committing, or removing those changes clears their rows and Explorer dots on the next refresh. Shell-only changes to never-touched paths appear in Git/Explorer marks, not this list.

This is **current Git state for session-touched paths**, not an exact session-start diff or a claim that the session authored every change. Pre-existing and external edits can be included. Branch navigation changes the candidate list, not disk contents or saved messages. Files in other repositories are checked separately; the Git summary still describes the working project.

Click a file for its current diff. Staged and unstaged changes are shown separately; row totals sum both layers. Untracked files are compared against empty content. Conflicts, binary files, and unsupported changes show a status instead of invented line counts. Diff previews are limited to 1 MiB and 20,000 source lines.

Unverifiable paths appear under **RECORDED FILES** as history only. Their previews show recorded operations, not a current diff, and they have no pending dot or current line counts. Refreshes mark old data as updating; read failures are not treated as clean state.

### Explorer and project switching

Explorer includes hidden and ignored files, loads folders only when expanded, and supports read-only previews. Files larger than 1 MiB, files containing NUL bytes anywhere in the bounded preview buffer, and invalid UTF-8 show an explanation instead of a preview. This is a binary-content heuristic, not detection of every binary format; legacy non-UTF-8 text is not previewed.

Use **Alt+E → Alt+G** to browse the parent, project, home, or an entered folder. The `..` row also opens the parent. Relative paths resolve from the current Explorer location; quotes, spaces, `~`, other drives, and accessible network shares are supported.

**Browsing never changes the agent's working project.** Use **Open this folder as working project…**, **Switch working project…**, or `/midnight project <path>` to switch explicitly. Command-relative paths resolve from the working project.

Switching asks for confirmation and creates a fresh persistent Pi session. It carries over only your unsent draft—not conversation history—so review relative file references. It is blocked while work, compaction, or queued messages remain, and is unavailable with `--no-session`. Use `/resume` and show all projects to return to the old conversation. A header-only session file left unchanged by hooks is removed if switching is cancelled; a fatal destination-initialization error may require restarting Pi and resuming the old session.

### Compact tools, titles, and speed

- **Compact tools:** one-line activity rows replace tool-output boxes: `○` queued, `●` running, `✓` completed, and `!` failed, followed by a muted operation name, readable target, and compact result. Long targets are clipped before the result so failure status remains visible. Ctrl+O or a click expands Pi's normal output; failures remain visible. Recognized expanded codemode command results are formatted for readability. The renderer itself leaves saved/model-facing results unchanged; the separate Trim-1 context stage may select eligible log lines. Use `/midnight compact off` for Pi's default rendering; Ctrl+T controls thinking blocks separately.
- **Automatic titles:** unnamed interactive sessions get short titles from the current model. Named sessions have a five-minute request cooldown, and unchanged conversation text skips the request. Manual `/name` titles are preserved; `/midnight title off` disables automatic naming and `/midnight title auto` resumes it. These settings survive reload/resume. **Title requests use your provider and may incur charges.**
- **Token speed:** the footer shows tokens/sec, response duration, and time to first token (TTFT), in fullscreen and regular TUI mode. Measurements include turn preparation and network time but exclude tool execution. `~` means a streaming estimate; reported output tokens replace it on completion. Missing timing stays unavailable. These stats make no extra model requests.

### Clarification questions

Midnight registers **`midnight_question`** automatically when the package loads—no separate question extension or opt-in is needed. Pi can pause for one focused decision, show up to six numbered alternatives with short descriptions, and offer **Other — write my own answer…**. With no alternatives it opens text input directly. The picker uses Pi's native dialogs, active theme, and selection keybindings in both fullscreen and regular TUI mode; Midnight's panel shortcuts and mouse actions stay out of its way. An open Midnight preview is closed before the question appears.

Use **Up/Down → Enter** to choose, or **Escape** to cancel (custom `tui.select.*` bindings apply). Other opens a text-input dialog; Enter submits and Escape cancels the question. Blank input also leaves it unanswered. Answers are limited to 4,000 characters. Compact tool rows show the question and answer or explicit cancellation; Ctrl+O reveals the full result.

The tool adds model guidance to **ask before consequential assumptions** about requirements, scope, behavior, architecture, compatibility, privacy, cost, or irreversible actions. It tells Pi to inspect available context first, offer concrete alternatives and trade-offs, and avoid interrupting for trivial details or choices you already made. Explicit requests to use its judgment are respected. This is guidance, not a guarantee that every model will ask at the right time. You can also request it directly: **“Use midnight_question to ask me which approach I prefer.”**

Cancellation is **not consent and does not select a default**: the result tells the model to pause dependent work and not immediately re-prompt. Session replacement, reload, shutdown, and conversation navigation cancel pending questions and discard stale answers. The tool is sequential and model-only, so codemode scripts cannot open dialogs. It also works with RPC clients that implement Pi's extension UI protocol; print/JSON runs return an explicit unavailable result so the model can ask in ordinary chat instead. It does not open a second question over another pending Midnight question or folder/model dialog.

**Not command approvals or a sandbox:** this does not change Pi's tool permissions, add per-command confirmations, or enforce an approval gate. No extra model or network requests are made by the picker itself. Questions and answers persist in the conversation and reach your active coding model—**do not enter credentials or other secrets**. No personal/global Pi configuration is modified; the feature follows whichever Midnight package you load.

### Native local evidence ledger

Midnight keeps a small, branch-aware investigation ledger inspired by [LongHarness](https://arxiv.org/abs/2610.13075). It separates **evidence** (source-linked observations), **claims** (agent interpretations supported by evidence IDs), and **gaps** (unanswered, decision-changing questions). It is bookkeeping, **not independent verification**: a valid reference does not prove that a source supports a claim, and exit code zero does not prove correctness.

**Passive by default:** when loaded, Midnight records bounded metadata receipts for `bash`/`powershell` results that include a structured `exit_code`, and for schema-valid `midnight_log_triage` results. It never infers exit codes from prose, copies command strings or log output into receipts, or creates conclusions automatically. Log-triage receipts retain source/selection hashes and remain advisory with unknown exit code, including local/cache results and partial failures. Tool-call IDs (and parent IDs for nested codemode calls) link receipts to their original tool observations.

For substantial investigations, use the **`midnight_evidence`** tool:

```json
{ "action": "add", "kind": "evidence", "text": "The handler aborts pending work", "path": "src/evidence/index.ts", "startLine": 100, "endLine": 110 }
```

Choose the actual relevant lines; that range is only an example. Use the returned ID in a claim or gap:

```json
{ "action": "add", "kind": "claim", "text": "Pending evidence work is cancelled on shutdown", "refs": ["<evidence-id>"], "applicability": "current" }
{ "action": "add", "kind": "gap", "text": "Does branch navigation discard late results?", "refs": ["<claim-id>"] }
{ "action": "list", "kind": "claim", "limit": 10 }
```

- **Inspect:** `list` returns newest-first bounded pages (default 10, maximum 20); use `offset`/`nextOffset`, `kind`, or `id`. `includeInactive: true` also lists superseded, retracted, and resolved records. An exact `id` can retrieve an inactive record on the active branch.
- **Correct:** add a replacement with `supersedes: "<id>"` (same kind). Old entries remain recoverable; dependent claims/gaps need review. `retract` requires `id` and `reason`. `resolve` requires a gap `id`, `reason`, and active, non-review evidence `refs`. Resolved gaps reopen for review if their supporting evidence is invalidated.
- **Reassess:** current claims are conservatively marked for review after **any** observed shell/edit/write completion, including failures, and on session load or conversation-tree navigation. Midnight does not parse commands to guess which ones were read-only. Historical claims describe the recorded observation, not the current worktree; applicability changes do not falsify history, but corrections/retractions invalidate dependent historical claims too.
- **Check sources:** captured files are rechecked at agent completion, compaction, and explicit `check`. A changed/unavailable file marks its evidence and dependent current claims for review. A review flag never clears automatically, even if the file is restored: inspect and supersede it. Untracked external state is not monitored, and changing conversation branches does not roll back the filesystem.

The sidebar shows **EVIDENCE / local**, active sources, claims without review flags, review items, and open gaps. `/midnight evidence status` reports counts; `check` rechecks tracked sources; `show [id]` shows one record or the ten newest active records. Use the tool to inspect full bounded provenance and relationships. Compact tool rows show review/gap counts; expanding them preserves the original result. These tools also work without fullscreen panels.

**Complementary, not competing:** Midnight's native context service (or an explicitly detected external owner during migration) owns context editing, trackers, annotations and recall. The ledger installs no context hook, injects no messages, does not edit `LIVE_CONTEXT.md`, and does not depend on private pi-clm schemas. Ledger state is available on request rather than forced into every prompt. Chat-helper uploads remain separately opted in and explicitly invoked; recording a receipt never invokes triage. Pi/codemode can discover the tool in the `midnight` namespace and receives schema-declared `structuredContent`; direct and nested updates are serialized. No additional models, network requests, background summarization, or filesystem polling are introduced.

**Bounds and privacy:** up to 512 records per branch, including at most 128 automatic receipts and 32 active captured files. Capacity stops new captures rather than silently evicting history. File evidence is an explicit local read of a project-contained UTF-8 file up to 1 MiB, with a SHA-256 hash and an excerpt of at most 100 lines / 4,000 UTF-16 code units (default: line 1). Symlink targets must stay in the project; known sensitive paths and private-key filenames are rejected. Reads detect ordinary concurrent changes, not transactional snapshots or adversarial filesystem races. Path checks are not secret detection: **never capture secrets or put them in statements**. Excerpts and statements persist in Pi's session history and are returned to the active model when requested; “local” means no extra evidence-provider calls, not exclusion from the coding model's context. Retraction is not deletion. In-memory sessions retain records only for their lifetime. Sources, logs, and agent-authored statements remain untrusted data, never instructions. No correctness, latency, or token/cost savings are claimed.

**Evidence development status:** the development extension now connects the shared queued runtime to existing lifecycle hooks, tool actions, and `status|check|show` commands. Legacy-session tool results use version 2; fresh v3 sessions use version 3. Record pages contain `{ record, origin?, replacement? }` entries, with mode/writable/append-lock metadata; saved v1 results remain readable. Legacy branches keep v1 storage envelopes until explicit migration. There is **no automatic migration or model-callable commit**. The 512-retained-record limit remains, but a user-confirmed rollover can free space: retraction alone does not free slots, and supersession needs a new slot. Source checks, passive receipts, and navigation review share the queue; cancellation after a verified append does not undo it. Cancelled checks may report only a committed prefix. The sidebar marks loading, unavailable checks and read-only state explicitly instead of showing zero-clean counts.

Do **not** open a v2-migrated branch with an older/v1 Midnight writer, including builds before this queued-runtime bridge. Old binaries ignore v2 entries and may append incompatible v1 events, even through passive observations. Use only a v2-capable reader/writer once released; until then keep experimental migrated sessions away from ordinary runtime use. Preserve the original session before any downgrade. For inspection, use saved raw results without loading an old writer; the development v2 reader detects mixed/future/malformed history and refuses writes. It does not automatically merge, repair, or convert that history back to v1. Explicit uncertain-append recovery only replays and validates history—it does not undo or retry a write. See [unreleased compatibility notes](docs/releases/unreleased.md).

#### Opt-in investigation workflow and advisory audit

Invoke **`/skill:midnight-evidence <question>`** for a substantial evidence-led investigation. The skill is explicit-only, not automatically selected or injected. It guides gap prioritization, original-source inspection, supported claims, revision, and honest qualified stopping. It does not make routine small edits require ledger administration or authorize extra commands, provider calls, or paid evaluations.

Before a substantial answer, explicitly select the relevant claims:

```json
{ "action": "audit", "selected": ["<claim-id>"], "limit": 20 }
```

Audit is **read-only and advisory**. It replays only active-branch evidence, checks selected claims/support plus recorded linked concerns and resolution support, and attempts bounded hashes for at most **32 distinct file paths**. It shares the runtime queue but does **not** initialize sessions, append review events, publish sidebar updates, clear review, run proposed checks, or call a provider. Cancellation, branch movement, and session replacement discard stale work.

Inputs allow **1–20 unique claim IDs**. Findings are paginated (default/max 20); use `nextOffset` and inspect `total`, not just the current page. Each call reassesses the current state; pages are not a frozen transaction. Results include availability, selected claim applicability, file paths attempted (`filesChecked`, including failed reads), legacy relationship uncertainty, invalid stored events, capacity and pending navigation review. Read-only or append-locked history is unavailable, not clean. Missing/inactive support, review flags, open/reviewed concerns, receipt-only observations, and changed/unavailable/unchecked files remain explicit. Unrelated gaps are excluded.

**No findings does not mean verified.** The audit cannot judge whether evidence actually supports a conclusion, detect unrecorded gaps, or check untracked external state. Legacy resolved-gap concerns may be lost; `legacyRelationships` discloses incomplete coverage without inventing links. Tool receipts, hashes and exit codes are observations—not proof. Sidebar source counts include receipts and must not be read as substantive-support coverage. Inspect material findings, then investigate or qualify the answer; provisional answers are permitted. No reasoning-quality or token/cost benefit has been measured.

#### Structured review and relationships in new sessions

Run **`/new`** with this development extension loaded to enable v3 evidence semantics. Activation requires Pi's explicit `new` session event and no preexisting conversation entries. Ordinary process startup, `/reload`, resume, fork, and an empty evidence ledger are not proof of freshness and never upgrade old sessions. Forks/reloads of an already initialized v3 branch retain its persisted semantics. Existing v1/v2 sessions keep their original replay and hashes; even rollover does not upgrade them.

In v3 sessions, use `concerns: ["<claim-or-record-id>"]` when adding a gap and `resolvedBy: ["<evidence-id>"]` when resolving it. Claim `refs` remain evidence support. For compatibility, gap-add `refs` aliases concerns and resolve `refs` aliases resolution support; do not combine an explicit relationship with `refs`. Existing sessions reject the new fields. Gap records retain separate concerns and resolution support; their returned `refs` is the dependency union (at most 16 distinct IDs). Rollover carries both relationships. Resolution/reopening preserves concerns, and resolution never clears earlier review.

V3 `reviewReasons` stores up to eight distinct structured causes with explanations and dependency IDs where applicable: source changed/unavailable, dependency superseded/retracted/review, possible worktree change, session reload, and branch change. `reviewOverflow` is sticky when additional causes cannot be retained; it never means clean. `/midnight evidence show <id>` displays reasons and relationships. Matching/restored sources do not clear review. Legacy prose is not reclassified by guessing its meaning.

V3 history uses `midnight-evidence-v3` entries. **Do not open it with a v1/v2-only writer**, even for passive observation. Initialization failure never retries or falls back to legacy writes within the active runtime. If no initialization entry was recorded, start a new session; recovery does not create it. If the entry became visible before an uncertain append failure, confirmed recovery validates it without retrying. No existing-session upgrade path is included.

#### Explicit evidence capacity recovery (development)

1. Ask the tool for `{ "action": "preview", "selected": ["<record-id>"] }`, or run `/midnight evidence preview <id> ...`. Use `selected: []` or `preview --empty` only to deliberately carry nothing. Dependencies are included automatically; preview refuses more than **256 carried records / 2 MiB**.
2. Inspect the paginated carried records, omitted-active IDs, review IDs and warnings. Repeat the same selection with `offset`/`limit` for more pages; an unchanged preview retains its token. Omitted records remain historical, **not resolved**. Carried evidence is not recaptured and review flags remain.
3. Run `/midnight evidence commit <token>` yourself. An **idle interactive TUI** must confirm the carry/omission counts and old-writer warning. Declining, noninteractive mode, a replaced session or changed branch cannot authorize a commit. New evidence writes invalidate a stale preview; prepare another rather than silently recomputing the confirmed selection.

For historical inspection, use `{ "action": "archive", "locator": <preview.predecessor>, "limit": 20 }`. The locator contains `setId`, `anchor`, and `digest`. Continue a scan using its returned cursor as `locator`; pages use `offset`/`limit`. Each call inspects at most 2,048 entries; incomplete/unavailable totals stay unknown. Cursors are session-local and expire on branch movement. Save the predecessor locator from the preview for later lookup; an origin record ID alone is not a complete archive locator. Historical results do not establish current source freshness.

After an uncertain append, `/midnight evidence recover` asks for confirmation and replays the current branch before unlocking it if valid. It never retries or undoes the append, repairs incompatible history, or clears review. Commit and recovery are unavailable through the model tool and in print/JSON/RPC modes. Confirmation dialogs retain input ownership and close file previews. These are development controls: manual fullscreen/reload compatibility remains an unverified release gate; automated tests are not a substitute.

### Local-first log triage with an optional chat helper

Keep your coding model in charge. `midnight_log_triage` works **without a helper key or extra model installation**: local extraction is available by default. It returns line-numbered evidence, diagnostic groups, a full local snapshot and SHA-256 hashes. An **optional, explicitly selected Pi chat model** can classify and summarize ambiguous logs in **one request**. It never changes your coding model, runs commands, edits source, rewrites history, or replaces Pi compaction.

**Helper uploads are off by default.** To select a small chat model from a provider already configured in Pi:

1. Load the local Midnight package and run `/reload` if already loaded.
2. Run `/midnight triage model` to open the native helper-model picker (Up/Down → Enter; Escape cancels).
3. Choose a physical chat model with configured Pi authentication. Selection leaves uploads off and does not change the coding model. Alternatively, list entries with `/midnight triage models` and select one explicitly with `/midnight triage model provider/model-id`.
4. Run `/midnight triage on` and confirm sharing selected log text with that model's configured provider.
5. Ask Pi: **“Use midnight_log_triage on .artifacts/test-output.log, then investigate using the original evidence.”**

The helper uses Pi's public model registry and request-time provider authentication, including the configured auth route where supported. **Access to the coding model does not guarantee access to the helper**; OAuth subscriptions, API credentials, scopes and billing differ. Only chat models qualify: classifier-only models (including GPT-6 Luna in Pi's catalog) cannot supply a generated summary. Virtual/router models are rejected to avoid hidden helper routing. Midnight never guesses a cheap model or silently falls back to the coding model. A missing/unavailable helper returns local evidence with a limitation; no fallback provider is called.

Create a UTF-8 log inside the working project first. For example, in PowerShell (capture the real exit code separately):

```powershell
New-Item -ItemType Directory -Force .artifacts | Out-Null
npm test 2>&1 | Out-File -Encoding utf8 .artifacts/test-output.log
$testExitCode = $LASTEXITCODE
```

Example tool arguments: `{ "path": ".artifacts/test-output.log", "mode": "auto", "maxLines": 200 }`. Only ordinary UTF-8 `.log`, `.txt`, or `.out` files up to **1 MiB** inside the working project are accepted. Escaping symlinks and known sensitive paths are rejected.

- **Selection:** omit `startLine` to prioritize the first failure, distinct diagnostic groups with nearby context, and final output. For large logs, bundled local Trim-1 ranks additional lines after validation/redaction; an optional `query` focuses relevance. Remaining space uses a tail rather than repeated diagnostics. If ranking is disabled, unavailable or outside its bounds, existing selection remains. With `startLine`, scan an unranked contiguous window instead. At most **400 complete source lines / 24 KiB**, including line-number prefixes, reach the helper. Exact selected/omitted ranges distinguish local scanning from uploaded evidence.
- **Grouping:** identical trimmed diagnostic lines are grouped after redaction, with counts and first/last line numbers. Output is capped at 24 groups / 6 KiB; omitted groups and clipped messages are marked. Passing test names containing “error” or “failure” are not treated as failures.
- **`mode: "auto"` (default):** use local evidence for fully selected small windows (at most 24 lines, 3,000 UTF-16 code units and 4 KiB), recognized diagnostic groups whose representatives fit in local evidence, or observed Node/TAP totals with zero reported failures/cancellations and a duration. Otherwise use the helper only when selected and authorized; without it, return local evidence with a limitation.
- **`mode: "local"`:** never call a provider. No helper credentials or consent required.
- **`mode: "remote"`:** bypass local gates when a helper assessment is useful, but reuse successful cache entries. Does not bypass model selection, consent, project boundaries or limits. If the helper is off/unavailable, return local evidence with a limitation.

Recognizers cover TypeScript error codes, selected npm dependency/environment codes and common failed-test markers—not every log format. Prefer dedicated local parsers for structured reports such as JUnit. Local observations and generated summaries are advisory. Unknown output is never declared clean, and **`exitCode` is always `null`**; record the command's actual exit code independently.

**Structured results:** the backward-compatible version-2 output schema includes mode (`local`, `remote`, `cache`), reason, diagnostics, scanned/selected/omitted ranges, evidence, source/snapshot hashes, category provenance, summary, errors and request/usage/timing fields. Ranked-selection attempts add optional `trim` status/reason, elapsed time and pinned revision metadata. New helper results also identify `helperModel` and `costBasis: "catalog_estimate"`. The chat helper does not supply calibrated confidence scores.

**Caching:** up to 32 successful, non-truncated assessments are kept in session memory with LRU eviction. Keys include canonical project/source identity, redacted numbered selection hash, selection settings, model/provider/endpoint and prompt revision. Every call revalidates and snapshots the source. Cache hits do not re-add provider usage; local/cache results still work at the request cap. Failed/malformed/cancelled/truncated results are not cached. Changing the helper model, disabling uploads, reload, session replacement or shutdown cancels pending work and clears the cache. Changing a model requires fresh consent, but does not reset the request budget.

| Setting | Default | Meaning |
| --- | --- | --- |
| `MIDNIGHT_TRIAGE_MODEL` | Unset | Exact `provider/model-id` chat helper; never automatically selected |
| `MIDNIGHT_TRIAGE_ENABLED` | Unset | Exactly `1` persistently authorizes explicit helper uploads in every project/session when a model is selected |
| `MIDNIGHT_TRIAGE_MAX_REQUESTS` | `20` | Attempt cap since session start/reload, 1–1000; each uncached helper assessment reserves one |
| `MIDNIGHT_TRIAGE_TIMEOUT_MS` | `15000` | Request timeout, 100–60000 ms |

Interactive selection/consent are session-local and reset on reload/session replacement. Cancelling the picker leaves the current helper, consent, cache and request budget unchanged. Native dialogs retain keyboard/mouse input ownership; open previews close before a dialog. The picker also works with RPC clients supporting Pi's extension UI protocol; print/JSON modes require explicit model arguments. Session replacement, tree navigation and shutdown cancel pending dialogs and discard stale selections. For print/JSON/RPC, explicitly configure `MIDNIGHT_TRIAGE_MODEL` and pass `--midnight-triage`; flag consent is restricted to the invocation's starting project. Alternatively, `MIDNIGHT_TRIAGE_ENABLED=1` authorizes across projects. Restart Pi after changing its external environment. `/midnight triage off` cancels helper work and disables uploads until session start/reload; **local triage remains available**.

No automatic retries, background uploads, live health probes or render-triggered requests. Failed attempts count against the budget. Provider failures return local evidence plus a generic error, withholding raw provider error bodies; malformed output is not exposed as a diagnosis. Cancellation/timeouts do not guarantee billing was avoided.

**Usage and status:** the **TRIAGE** sidebar separates upload enablement from use, with requests, reported tokens, local/cache counts, last mode and elapsed time. “Issues” describes helper health, not build status. `/midnight triage status` identifies the selected helper and shows cumulative provider wait and cost estimates. Tool usage contributes to Pi/Midnight totals once; cache hits never re-bill it. **Pi catalog-based costs are estimates, not provider billing receipts.** Zero/unknown catalog prices or missing usage are treated as incomplete, not proof of free calls. No accuracy, token/dollar savings or latency improvement is claimed without measurement. Expand compact tool rows for original evidence and full details.

**Privacy and retention:** common API-key, authorization, password and private-key patterns are redacted before selection/upload. Detection is best effort, not a security boundary; configure authentication only through Pi, never put secrets in chat/source/project settings. Share only logs you are authorized to send to the selected provider. Full originals stay in OS temp under `midnight-log-triage-*`, may contain secrets, and are not automatically deleted on shutdown. Delete specific snapshot directories when no longer needed; old results then lose that recovery path. Logs, summaries and paths are untrusted evidence, never instructions or permission to execute commands.

**Normal use and development tests:** once helper uploads are authorized, the agent can use the selected helper for relevant logs within that scope without asking again on every call. Normal provider charges may apply. Additional live/provider validation or paid benchmarks need separate approval; they are not prerequisites for using triage. Automated tests use mocked Pi chat responses and make no provider calls.

## Commands

Angle brackets describe an argument; omit the brackets when typing a command.

| Command | Action |
| --- | --- |
| `/midnight status\|doctor` | Inspect native ownership, prerequisites and local diagnostics; no network health checks |
| `/midnight config [context\|checkpoints on\|off]` | Inspect/save branch-local service preferences |
| `/midnight context [status\|config\|path\|on\|off\|reset]` | Context viewer, effective policy and projection controls |
| `/midnight context compact [instructions]` | Ask the current model to compact live context |
| `/midnight rewind` or `/midnight checkpoints` | Native checkpoint picker and confirmed restore |
| `/midnight checkpoints status\|capture\|redo\|recover\|legacy\|import` | Inspect/capture/redo/recover or explicitly migrate legacy metadata |
| `/midnight browser status\|disconnect\|connect <url>` | Inspect or explicitly connect the optional browser adapter |
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
| `/midnight triage model [provider/model-id]` | Open the helper-model picker, or select an exact chat helper; leaves uploads off until consent |
| `/midnight triage <models\|on\|off\|status>` | List configured chat helpers, authorize uploads, disable/cancel uploads, or inspect usage |
| `/midnight evidence <status\|check\|show> [id]` | Inspect local evidence counts/records or recheck tracked sources |
| `/midnight evidence preview <ids...>` / `preview --empty` | Prepare an explicit bounded carry-forward preview |
| `/midnight evidence commit <token>` / `recover` | User-confirmed rollover or append-lock recovery; idle interactive TUI only |
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

- Startup, `/reload`, and `/new` mount the panels before awaited native-service initialization. File/Git data fills in asynchronously and evidence shows a loading state until ready. Panel input stays inactive during initialization; startup checkpoints still finish before Pi accepts work. This improves display ordering, not the cost of checkpoint validation or snapshot reads.
- Filesystem/Git work is asynchronous and outside rendering. Reads are bounded and cached, requests coalesce, directories load lazily, and session analysis updates incrementally. There is no filesystem polling, recursive watching, or model call for ordinary UI updates.
- Reload, session replacement, and shutdown cancel pending work, discard late results, close previews, and restore Pi's layout. Project switching uses Pi's session APIs, not `process.chdir()`.
- Midnight preserves the transcript, editor, widgets, and custom footers. Panels are disabled in RPC, JSON, and print modes. Extensions that replace the whole fullscreen layout may conflict.
- Compatibility is pinned to **Pi 1.2.0** in the Pi library peer dependencies and the lockfile. Guarded internal accesses in `src/layout.ts` and `src/session-analysis.ts` have been reviewed against that release; unknown layouts are left alone. Other versions require a compatibility review and fullscreen interaction testing before changing the pins.
- Git/file reads detect ordinary concurrent changes but are not transactional snapshots. OS permissions still apply.

## Development

```powershell
npm ci --ignore-scripts
npm run check
npm test
```

`npm run check` runs Biome and TypeScript validation. `npm test` runs Node's test runner with injected I/O/component checks, mocked Pi chat-model responses, and real Git in temporary repositories; no provider calls are made. Evidence tests cover immutable corrections, dependency review, gap reopening, branch replay, nested receipts, source bounds, symlink retargets, cancellation, and structured results. Triage tests cover opt-in, request limits, log boundaries, redaction, symlink rejection, cancellation, partial failure, structured response validation, usage accounting, local gates, timing, and cache identity/eviction. A synthetic offline corpus in `tests/fixtures/triage-corpus.ts` checks early failures, repeated/mixed diagnostics, misleading passing-test names, Unicode, ambiguous output, and log-embedded instructions; it makes no model-quality or savings claims. Run focused tests during development and the full check/test commands once for final validation; avoid unrelated or repeated tests. Test fullscreen interaction separately with only the local extension loaded.

For the synthetic offline context/checkpoint benchmark, run `node --experimental-strip-types scripts/benchmark-hot-paths.mjs --output .artifacts/performance/result.json` (optional `--scenario context|checkpoints`). It reports fixture timings and Git process counts, not interactive/provider latency or a general speed guarantee.

Native suite regression tests cover mirror validation, projection, annotations, budgets/overflow, ownership, mocked browser registration, scoped restore, recovery, legacy import, raw CRLF bytes and Git object reachability. Before publishing a release, also check fullscreen keyboard/mouse/resize/reload behavior and an isolated one-package installation; offline tests and package manifests do not establish those manual/runtime gates.

See [NOTICE](NOTICE), [native source provenance](docs/native-suite-provenance.json), [upstream licenses](licenses), and [LICENSE](LICENSE).
