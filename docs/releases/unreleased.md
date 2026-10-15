# Unreleased development notes

## Evidence saved-result compatibility (Phase 1A)

Compact tool rows recognize saved v1 summaries and strict v2 results. V2 rows distinguish preview-only output, committed writes, cancellation after append (including a committed check prefix), uncertain append locks, read-only history, and historical archive scans/unavailability. Unknown or malformed versions fall back to ordinary output. Expansion and disabling compact rendering preserve original results; no saved/model-facing data is rewritten. Rendering does no source checks, replay, archive I/O, or provider calls.

This is **not a released capacity fix**. The development extension now registers the queued v2 runtime through `src/evidence/register.ts` for existing lifecycle/tool/command paths. Tool results use version 2, with wrapped record pages (`{ record, origin?, replacement? }`) and explicit writable/append-lock metadata. Legacy branches continue writing v1 storage envelopes; there is no automatic migration. Passive receipts, source checks and navigation review share the queue; generation checks suppress stale completions. Loading, read-only and unavailable state is explicit in the sidebar. Cancellation after append preserves writes; cancelled checks may return only a committed prefix, and interrupted navigation review reports that committed work remains.

The 512 retained-record cap blocks supersession at capacity, and retraction does not free slots. Development controls now offer explicit recovery: the model or `preview <ids...>` command prepares bounded carry/omission/review pages, but only `/midnight evidence commit <token>` can commit after user confirmation in an idle interactive TUI. `preview --empty` explicitly carries nothing. The model tool cannot commit or unlock writes. Archive inspection accepts the preview predecessor locator or continuation cursor; each call retains its 2,048-inspection budget and 20-record page bound. `/midnight evidence recover` confirms a fresh replay before unlocking a valid branch; no automatic repair, retry or rollback is attempted. Noninteractive commits/recovery are unavailable. Old previews and confirmations cannot authorize changed branches or replaced sessions.

Confirmation dialogs coordinate with question/triage dialogs and panel preview input ownership. Manual fullscreen, reload and lifecycle compatibility remain unverified release blockers; these development controls are not a release certification. The old v1 runtime remains in source for characterization tests/shared request and receipt definitions, not live registration.

## Fresh-session structured semantics (Phase 1B/1C)

The live queued runtime now initializes v3 only on Pi's explicit `new` session event without existing conversation entries (`/new`). Startup, reload, resume, fork and an empty ledger do not authorize an upgrade. Existing v1/v2 schemas, replay and hashes remain unchanged; rollover preserves the current semantics. Persisted v3 initialization survives reload and fork.

V3 results expose up to eight structured review causes plus sticky overflow. Source checks distinguish changed from unavailable, retain restored-source review, and avoid duplicate reason appends. Dependency, worktree, reload and navigation reasons remain explicit. Gap `concerns` and `resolvedBy` are separate; `refs` is their bounded dependency union. Claim refs remain support. New tool fields are accepted only in v3 sessions; old refs remain aliases for add-gap/resolve inputs, not combined with explicit fields. Resolution never clears review, and rollover/archive preserve relationships and reasons.

Initialization uses the same verified append/uncertainty boundary. Failed initialization cannot silently fall back to legacy writes or retry within the runtime; if no initialization was recorded, start a new session. Confirmed recovery can validate an initialization already visible after failure but never retries it. Older v1/v2-only writers must not write v3 branches. No legacy upgrade is provided. Automated registration tests exercise disk reopen/fork and carry/archive behavior; manual fullscreen/reload validation remains release-blocking.

## Opt-in investigation skill and selected-claim audit

`/skill:midnight-evidence` explicitly loads the gap-driven workflow; it is excluded from automatic model invocation and uses the existing package skills discovery. No dependencies, prompt injection, automatic continuation or strict answer gate are added.

The `audit` tool action accepts 1–20 selected claim IDs, returns at most 20 findings per page, and attempts at most 32 distinct bounded file reads. It reports structural support, review, selected linked concerns/resolution support, changed/unavailable/unchecked sources, receipt-only observations and legacy uncertainty. Read-only/append-locked history is unavailable. Each call is a new bounded observation; pagination is not a frozen snapshot. No findings is not truth verification or proof that all relevant gaps were recorded.

Audit cold-replays through the existing FIFO without initializing, synchronizing lifecycle review, appending events or publishing counts. Branch/session/cancellation guards discard stale work. The skill uses audit before a substantial answer but allows provisional conclusions with explicit limitations. Existing source counts include receipts, not independent coverage. Routine validation uses injected/local sources and the existing test harnesses; no model evaluation or benefit measurement was performed. Manual UI/reload compatibility remains a release blocker.

## Downgrade / old-writer prohibition

- Never let an older/v1 Midnight writer operate on a branch containing `midnight-evidence-v2` entries. This includes development builds before the queued-runtime bridge, not just old release tags. Passive observations can write, so merely avoiding explicit evidence calls is insufficient.
- Old binaries ignore the new custom entry type; they cannot be retroactively made fail-closed. Saved-v2 rendering support is not v2 writer support. No released version is declared a safe v2 writer by these notes.
- Preserve the original session before changing versions. Keep experimental migrated sessions isolated from ordinary runtime use. Inspect saved raw results without loading an old writer, or use the queued v2 reader in a controlled development environment. Use a v2-capable build for any migrated branch; these notes do not designate a released safe writer.
- The queued reader refuses writes on mixed v1-after-v2, malformed, or future history. There is no automatic merge, downgrade conversion, session rewrite, or provenance deletion. Do not remove v2 entries to make an old writer appear compatible.
- User-confirmed recovery after an uncertain append reconstructs and validates history; it does not undo a committed append, retry it, or repair incompatible history. Cancellation after a verified append preserves the write; a cancelled multi-record check can report only its committed prefix.

Automated fixtures are not proof of fullscreen interaction or live migration safety. No provider or manual UI validation is included in this slice.
