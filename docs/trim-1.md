# Bundled Trim-1

Midnight includes Trim-1 and enables it by default for log triage and narrowly eligible model-facing tool output. It is a local line selector, not a chat model, summarizer, diagnostic authority or replacement for native context management. The package needs no separate Go/Trim installation, install script, provider call or runtime download.

## What runs

`src/trim/trim.wasm` contains the pinned upstream Go implementation and embedded model. `src/trim/worker.mjs` loads it with the bundled Go `wasm_exec.cjs` runtime inside a Node worker. The worker starts on demand, is reused, and does not keep the process alive while idle. Each context/triage owner has its own lazy worker; a busy worker returns fallback rather than accepting an unbounded queue. Abort, timeout, shutdown or lifecycle replacement terminates pending work. Ordinary module loading starts no worker.

Inputs are bounded to 1 MiB and 20,000 newline-separated pieces; inputs under 2,000 UTF-8 bytes, blank queries, NUL-containing input and existing Trim-1 markers are skipped. Query input is capped to the last 2,000 Unicode code points (within the upstream 8 KiB query bound). Calls have a two-second deadline including worker startup; invalid/non-finite scores, invalid indices, startup errors, missing assets and timeouts return fallback. The worker's V8 old-generation limit is 128 MiB; that is **not** a hard bound on total process/WASM memory. Input and concurrency limits also bound work.

`MIDNIGHT_TRIM=off` disables new processing; restart Pi after changing its environment. It does not reverse already accepted mirror edits or change helper-upload consent. No network code or credentials are needed for inference. The packaged artifact is larger than the approximately 1.2 MB model because it includes Go runtime and feature-extraction code.

## Log triage

`src/triage/log.ts` retains project/symlink/sensitive-path checks, UTF-8 validation, bounded reads, ANSI cleanup and credential redaction before ranking. The original-byte snapshot is unchanged. Only oversized selections without an explicit `startLine` use ranking. The optional `query` argument accepts up to 2,000 characters; without it the focus is build/test failures, causes, errors, stack traces and final test totals.

`src/triage/analysis.ts` scans diagnostics on all lines in the selected scan range, not a trimmed intermediary. It reserves existing first/distinct diagnostic and nearby-context/final-output priorities, then adds ranked lines and neighbors before the ordinary tail fill. Ranking never relaxes the existing 400 complete lines / 24 KiB cap, changes original line numbering, infers an exit code or upgrades local diagnosis confidence. Explicit windows keep their contiguous semantics. Ranked selection is Midnight's bounded policy, not upstream `Compress()` output; upstream benchmark figures therefore do not establish its quality.

Result `trim` metadata, when a ranking attempt is made, records `used`, `skipped` or `fallback`, its reason, elapsed milliseconds and the pinned source revision. `used` means scoring ran, not that the selection differs from baseline or saves tokens. Provider `mode`, attempts, timing and usage still describe only the optional chat helper. Query/model selection does not enable uploads. Cache keys still include the exact numbered/redacted selection hash, so changed selected evidence cannot reuse an incompatible helper result.

## Context eligibility and recovery

`src/context/trim.ts` runs inside native context projection, before the optional observation cap and existing overflow guard. It only considers single-text tool results linked to their original assistant tool call:

- Complete `read` calls with no `offset` or `limit`: `.log`, `.out`, or `.txt` names beginning with `build`, `test`, `lint`, `check`, `compiler` or `ci` followed by `.`, `_` or `-`.
- Exact bash commands: `npm test`, `npm run check|test|build|lint`, `pnpm test|build|lint`, `cargo test|check|build`, and `go test ./...`.

Shell wrappers, compound commands, redirected commands, arbitrary flags, codemode aggregates, source/document reads, known instruction/credential names, structured-content fields, JSON/XML-looking output, code fences, mixed/image content, already truncated/trimmed output and explicit recovery windows are excluded. These are conservative eligibility heuristics, not a security classifier. Custom tools impersonating built-in names are outside this contract. No user/system message is trimmed.

Context inputs must also have at least 4,000 UTF-16 code units. Upstream balanced `Compress()` proposes retained indices; Midnight additionally preserves recognized diagnostic lines with surrounding context and the tail. It applies the result only if the **complete excerpt including its recovery notice** is at least 10% smaller in UTF-8 bytes. Byte reduction is not provider-token or billing measurement.

The query is the preceding user message, not every subsequent question. Up to 128 decisions are retained per lifecycle, including no-op/fallback decisions, to avoid repeatedly changing old context. At most four new attempts run per context event (therefore at most roughly eight seconds of worker deadlines, plus bounded local I/O); once decision capacity is reached, further results stay unchanged. Snapshot writes are capped at 16 MiB of cumulative source bytes per lifecycle. Already accepted projection prefixes are protected from reprocessing. Session start/tree navigation/native compaction/shutdown reset decisions and cancel pending work; an epoch guard discards late context results.

Before applying a cut, Midnight writes the exact original tool text to `<mirror directory>/trim/<sha256>.txt` with restrictive permissions where supported. If saving fails, the original remains visible. The excerpt links to that snapshot and identifies its SHA-256; retained lines stay verbatim and in order with explicit gap counts. Read the snapshot with `offset`/`limit` to recover omitted context without immediately retrimming it. No source files, saved tool messages or raw transcript entries are changed.

Context snapshots share the mirror's temporary lifetime and cleanup/stale-sweep rules. A persisted projection can outlive its temporary snapshot; the immutable original tool result remains in session history. Snapshots and session history may contain secrets; local selection is not redaction or secure deletion. Triage originals use their separate documented retention policy.

## Provenance and rebuilding

- Upstream: <https://github.com/caveman-ai/trim-1>
- Pinned commit: `f16ff28a9a84bfa7ffa89c12b7e20ad9e4a21c6a`.
- Model: `vendor/trim-1/model.bin`, 1,245,358 bytes.
- Model SHA-256: `75478721d9992c3cbe6a1874ddf363ae6d78935a1fa526fb6fac1d0f6f3cdc2d`.
- Toolchain: Go **1.27.2**, `GOOS=js GOARCH=wasm CGO_ENABLED=0`, standard library only.
- Original Go sources/model and upstream test fixtures are retained in `vendor/trim-1`; `.gitattributes` preserves LF fixtures on Windows. Midnight's bridge is `vendor/trim-1/cmd/midnight/main.go`.
- Apache-2.0: `licenses/trim-1.txt` and `vendor/trim-1/LICENSE`.
- BSD-3-Clause Go math attribution: `vendor/trim-1/LICENSE-go`; Go runtime: `licenses/go.txt` and the runtime file's copyright header.

Maintainers can rebuild explicitly with the pinned Go toolchain on PATH:

```sh
node scripts/build-trim.mjs
cd vendor/trim-1
go test ./...
```

Alternatively set `GO_BINARY` to the absolute path of the Go 1.27.2 executable. The rebuild script checks the version and model hash, disables toolchain downloads/module proxy use, builds with `-trimpath -ldflags="-s -w -buildid="`, and copies the matching `wasm_exec.js` as `.cjs`. There is no npm build/install hook. Source, licenses, bridge, rebuild script and runtime assets are included in the package; local downloaded toolchains and logs are not.

## Validation and limitations

Offline tests compare bundled WASM selection to upstream's golden fixture, verify the model hash and deterministic scores, exercise fallback/cancellation, and check redaction, diagnostic retention, source ranges, exact CRLF/Unicode snapshots and eligibility exclusions. Upstream Go tests include bit-for-bit prediction parity with exported training-library predictions. These establish fixture/integration behavior, not general reasoning quality.

The [upstream model card](https://huggingface.co/caveman-so/trim-1) reports small balanced savings on coding outputs and significant evidence/answer losses on some code and multi-hop tasks. Never turn selection scores into diagnostic confidence. No Midnight accuracy, token savings, provider-cost reduction or latency benefit has been measured. Manual fullscreen/reload and isolated installation compatibility remain separate release gates; this integration does not claim they passed.
