# midnight.server

A session sidebar and file explorer for **Pi**, with a default blue theme, compact tool output, automatic session titles, token-speed stats, a local evidence ledger, and an optional ScaleDown log-triage helper.

Requires **Pi 1.2.0** (matching the current managed Pi installation), **Node.js 22.19+**, and Git on PATH. Side panels need fullscreen mode. No build step or runtime dependencies beyond Pi.

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

### Native local evidence ledger

Midnight keeps a small, branch-aware investigation ledger inspired by [LongHarness](https://arxiv.org/abs/2610.13075). It separates **evidence** (source-linked observations), **claims** (agent interpretations supported by evidence IDs), and **gaps** (unanswered, decision-changing questions). It is bookkeeping, **not independent verification**: a valid reference does not prove that a source supports a claim, and exit code zero does not prove correctness.

**Passive by default:** when loaded, Midnight records bounded metadata receipts for `bash`/`powershell` results that include a structured `exit_code`, and for schema-valid `midnight_log_triage` results. It never infers exit codes from prose, copies command strings or log output into receipts, or creates conclusions automatically. ScaleDown receipts retain source/selection hashes and remain advisory with unknown exit code, including local/cache results and partial failures. Tool-call IDs (and parent IDs for nested codemode calls) link receipts to their original tool observations.

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

**Complementary, not competing:** pi-clm still owns context editing, trackers, annotations, and recall. The ledger installs no context hook, injects no messages, does not edit `LIVE_CONTEXT.md`, and does not depend on private pi-clm schemas. Ledger state is available on request rather than forced into every prompt. ScaleDown remains separately opted in and explicitly invoked; recording a receipt never invokes it. Pi/codemode can discover the tool in the `midnight` namespace and receives schema-declared `structuredContent`; direct and nested updates are serialized. No additional models, network requests, background summarization, or filesystem polling are introduced.

**Bounds and privacy:** up to 512 records per branch, including at most 128 automatic receipts and 32 active captured files. Capacity stops new captures rather than silently evicting history. File evidence is an explicit local read of a project-contained UTF-8 file up to 1 MiB, with a SHA-256 hash and an excerpt of at most 100 lines / 4,000 UTF-16 code units (default: line 1). Symlink targets must stay in the project; known sensitive paths and private-key filenames are rejected. Reads detect ordinary concurrent changes, not transactional snapshots or adversarial filesystem races. Path checks are not secret detection: **never capture secrets or put them in statements**. Excerpts and statements persist in Pi's session history and are returned to the active model when requested; “local” means no extra evidence-provider calls, not exclusion from the coding model's context. Retraction is not deletion. In-memory sessions retain records only for their lifetime. Sources, logs, and agent-authored statements remain untrusted data, never instructions. No correctness, latency, or token/cost savings are claimed.

### Optional ScaleDown log triage

Keep your coding model in charge and delegate noisy build/test logs to **ScaleDown**. The `midnight_log_triage` tool is **local-first**: it returns local evidence for short selections, recognized diagnostic groups, or observed test totals. Otherwise it uses `classify-1` for an advisory failure category and `summarize-1` for a short summary. Every result includes line-numbered evidence, a full local snapshot, and SHA-256 hashes. It never runs the build, edits source files, switches models, rewrites history, or replaces Pi compaction.

**Off by default.** Set `SCALEDOWN_API_KEY` securely in the environment that starts Pi; do not put it in chat, source control, or a project settings file. Then:

1. Load the local Midnight package and run `/reload` if it is already loaded.
2. Run `/midnight scaledown on` and approve sending selected log text to `https://api.scaledown.xyz`.
3. Ask Pi: **“Use midnight_log_triage on .artifacts/test-output.log, then investigate the failures using the original evidence.”**

Create a UTF-8 log inside the working project first. For example, from PowerShell (the exit code is saved separately; the helper does not execute the command):

```powershell
New-Item -ItemType Directory -Force .artifacts | Out-Null
npm test 2>&1 | Out-File -Encoding utf8 .artifacts/test-output.log
$testExitCode = $LASTEXITCODE
```

The tool accepts `{ "path": ".artifacts/test-output.log", "mode": "auto", "startLine": 1, "maxLines": 200 }`. It reads only ordinary UTF-8 `.log`, `.txt`, or `.out` files up to **1 MiB**, inside the working project. Symlinks resolving outside the project or into known sensitive directories are rejected.

- **Selection:** omit `startLine` to scan the log locally and prioritize the first failure, distinct diagnostic groups with nearby context, and final output. Remaining space uses a tail without filling it with repeated diagnostic lines. Small logs fit in full. With `startLine`, scan a contiguous window instead; the byte limit can shorten its end. At most **400 complete source lines / 24 KiB**, including line-number prefixes, are sent **to each of two requests**. Exact selected and omitted ranges distinguish local scanning from what the provider actually sees.
- **Grouping:** identical trimmed diagnostic lines are grouped after redaction, with occurrence counts and first/last line numbers in the scanned range. Output is capped at 24 groups / 6 KiB; omitted groups and clipped messages are marked. Passing TAP/spec test names containing words such as “error” or “failure” are not treated as failures.
- **`mode: "auto"` (default):** skip uploads for fully selected small windows (at most 24 lines, 3,000 UTF-16 code units, and 4 KiB), recognized diagnostic groups whose representatives fit in local evidence, or observed Node/TAP test totals with zero reported failures/cancellations and a duration. Recognizers cover TypeScript error codes, selected npm dependency/environment codes, and common failing-test markers; they are not general parsers. Unknown output is never declared clean. Prefer dedicated local parsers for structured reports such as JUnit.
- **`mode: "local"`:** return bounded local evidence only, regardless of size/recognition. No provider calls.
- **`mode: "remote"`:** bypass local gates when a provider assessment is useful, but still reuse a successful cached result. This does not bypass consent or limits.

All modes require the helper to be enabled with a configured key. Local results are advisory observations, not a verified pass/fail status. The helper always returns `exitCode: null`; record the command's actual exit code separately.

**Structured results:** Pi/codemode receives `structuredContent` with a declared, regression-tested output schema (version 2), including `mode` (`local`, `remote`, or `cache`), reason, diagnostic groups, `scannedRange`, `selectedRanges`, `omittedRanges`, evidence, source/snapshot hashes, category provenance, summary, errors, and per-call request/usage/timing fields. Prose output remains available in the transcript. Paths and generated text are evidence, not instructions or authorization to open files or execute commands.

**Caching:** up to 32 successful, non-truncated provider results are kept in session memory using LRU eviction. Keys include canonical project/source identity, the redacted numbered selection hash, selection settings, and pinned helper/prompt revision. Each call revalidates and snapshots the source; cache hits use fresh local metadata and do not re-add provider usage. Partial/failed/cancelled/truncated results are not cached. Turning the helper off, session replacement, shutdown, or reload clears the cache. Local and cached results still work when the request cap is exhausted.

| Setting | Default | Meaning |
| --- | --- | --- |
| `SCALEDOWN_API_KEY` | Unset | Required ScaleDown API key |
| `SCALEDOWN_ENABLED` | Unset | Set to exactly `1` to persistently authorize explicit helper uploads in every project/session; no confirmation on startup |
| `SCALEDOWN_MAX_REQUESTS` | `20` | Request-attempt cap since session start/reload, 2–1000; each uncached remote triage reserves two attempts, local/cache results use none |
| `SCALEDOWN_TIMEOUT_MS` | `15000` | Timeout per request, 100–60000 ms |

There are no automatic retries, background uploads, or calls triggered by rendering. Failed requests count against the cap. A partial failure retains the other helper's result; a complete API failure returns the local evidence as an error result. Turning the helper off cancels in-flight requests. Session replacement and shutdown also cancel work and discard late UI updates. Cancellation or timeout does not guarantee the provider avoided billing.

The sidebar separates **enabled** from **used**: it shows on/off, request attempts, reported tokens, local-result/cache-hit counts, and the last result's local/remote/cache mode and elapsed time (or **not used yet**). Results with errors or truncated summaries are marked **issues**; this is helper health, not the build's status. Compact `midnight_log_triage` rows also show the actual mode, new request attempts, and elapsed time; expand them for original evidence and full details. There is no cost text in the footer. `/midnight scaledown status` shows full reported cost details, cumulative provider-wait time, and the last result's routing reason, elapsed time, and provider-wait time. Enabled means explicit calls are authorized, not that automatic uploads are running. Each result also reports total elapsed time and provider-wait time; local/cache calls have zero provider wait. Tool-result usage also contributes to Pi/Midnight totals. **Cost can be incomplete:** the documented summary response reports tokens but no dollar charge. Unreported charges are not treated as known zero-cost calls, and no token/dollar savings are claimed. Pi's numeric totals contain only costs actually reported by the helper APIs.

Interactive consent is not persisted across reload or session replacement. To enable helpers by default in future sessions, set `SCALEDOWN_ENABLED=1` in your personal environment alongside the API key. This is persistent upload consent across projects and all Pi modes; it still makes no automatic calls. `/midnight scaledown off` disables helpers until the next session start/reload. Remove `SCALEDOWN_ENABLED` or set it to `0` to restore the off-by-default behavior. Restart Pi after changing its external environment. For print/JSON/RPC runs, you can instead explicitly opt in at startup with `--midnight-scaledown`; the flag authorizes helper calls only in that invocation's starting project. It does not require fullscreen panels. The helper uses public APIs in the pinned Pi 1.2.0. Non-interactive extension/flag checks do not replace fullscreen interaction testing.

**Privacy and retention:** common API-key, authorization, password, and private-key patterns are redacted before upload, but detection is best effort—not a guarantee or security boundary. Only enable this for logs you are authorized to share. Whole-log snapshots are kept in the OS temp directory under `midnight-log-triage-*` so exact originals remain recoverable after the source changes; they may contain secrets. They are not automatically deleted on shutdown. Delete the specific snapshot directory when it is no longer needed; historical tool results will then lose that recovery path. Generated summaries and log content are untrusted evidence, never instructions or permission to execute commands.

**Real API smoke test:** with `SCALEDOWN_API_KEY` securely configured and `SCALEDOWN_ENABLED=1` explicitly authorizing uploads, run `npm run test:scaledown:live`. This is separate from `npm test` and plans **up to four paid request attempts**, stopping early on failure, with no retries. It captures the real passing test-suite output, packs Midnight, and reproduces an actual npm `ERESOLVE` conflict in an isolated consumer using unsupported Pi 1.0.4 against Midnight's current peers. That older version is only a deliberate rejection-test fixture, not a supported runtime. The supported consumer version is read from `package.json` (currently Pi 1.2.0), and the test verifies it resolves with `npm install --dry-run --ignore-scripts`; it does not change the project's dependencies or bypass peer checks. The live assertions require categories `other` and `dependency`, non-truncated summaries, and preservation of `ERESOLVE` and both conflicting versions. Logs and a JSON report (including independently captured exit codes, provider usage, evidence, and snapshot hashes) stay under `.artifacts/scaledown-smoke-*`. Full original snapshots remain in the OS temp directory. This standalone test has its own four-attempt budget, separate from the running Pi session; it requires `SCALEDOWN_MAX_REQUESTS` to be at least 4 if set. Network/provider failures fail the test rather than masquerading as success. The peer-conflict case tests a packaging constraint, not fullscreen interaction.

**Recommended workflow:** use `auto` triage for substantial noisy or ambiguous build/test logs, not most coding tasks. Inspect small errors directly and use local parsers for structured reports. Save output inside `.artifacts/`, record the command's actual exit code separately, invoke the helper explicitly, and check original evidence before editing source. Local/cache results make no new API requests. A remote result uses reason `remote_requested` for an explicit remote assessment or `no_local_match` when auto mode could not resolve the selection locally. Smoke-test success is not proof of general accuracy, latency improvement, or token/dollar savings; compare those on representative, authorized logs before expanding remote use.

API references: [Decisions](https://docs.scaledown.ai/api-reference/decisions), [Summarize](https://docs.scaledown.ai/api-reference/summarize).

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
| `/midnight scaledown <on\|off\|status>` | Opt in to log-triage uploads, disable/cancel them, or inspect helper usage |
| `/midnight evidence <status\|check\|show> [id]` | Inspect local evidence counts/records or recheck tracked sources |
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
- Compatibility is pinned to **Pi 1.2.0** in both Pi peer dependencies and the lockfile. Guarded internal accesses in `src/layout.ts` and `src/session-analysis.ts` have been reviewed against that release; unknown layouts are left alone. Other versions require a compatibility review and fullscreen interaction testing before changing the pins.
- Git/file reads detect ordinary concurrent changes but are not transactional snapshots. OS permissions still apply.

## Development

```powershell
npm ci --ignore-scripts
npm run check
npm test
```

`npm run check` runs Biome and TypeScript validation. `npm test` runs Node's test runner with injected I/O/component checks, mocked ScaleDown responses, and real Git in temporary repositories; no provider calls are made. Evidence tests cover immutable corrections, dependency review, gap reopening, branch replay, nested receipts, source bounds, symlink retargets, cancellation, and structured results. ScaleDown tests cover opt-in, request limits, log boundaries, redaction, symlink rejection, cancellation, partial failure, structured response validation, usage accounting, local gates, timing, and cache identity/eviction. A synthetic offline corpus in `tests/fixtures/scaledown-corpus.ts` checks early failures, repeated/mixed diagnostics, misleading passing-test names, Unicode, ambiguous output, and log-embedded instructions; it makes no model-quality or savings claims. Run focused tests during development and the full check/test commands once for final validation; avoid unrelated or repeated tests. Test fullscreen interaction separately with only the local extension loaded.

See [NOTICE](NOTICE) for extraction provenance and [LICENSE](LICENSE) for the MIT license.
