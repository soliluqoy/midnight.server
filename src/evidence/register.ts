import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { formatEvidenceResult } from "./format-result.ts";
import { TOOL_NAME } from "./index.ts";
import { type EvidenceDisplaySummary, EvidenceLedger } from "./model.ts";
import { PublicEvidenceParams } from "./public-params.ts";
import { type EvidenceLiveResultV2, PublicEvidenceResultSchema } from "./result-v2.ts";
import { EvidenceRuntimeV2 } from "./runtime-v2.ts";

export function registerEvidence(
	pi: ExtensionAPI,
	onUpdate: (summary: EvidenceDisplaySummary) => void = () => {},
	beforeDialog: () => boolean = () => true,
) {
	let summary: EvidenceDisplaySummary = { ...new EvidenceLedger().summary(), unavailable: "Loading evidence" };
	let context: ExtensionContext | undefined;
	let sessionId: string | undefined;
	let generation = 0;
	let pendingPreview: EvidenceLiveResultV2["preview"];
	let confirming = false;
	const publish = (result: EvidenceLiveResultV2) => {
		summary = {
			...result.summary,
			...(result.cancelledAfterAppend
				? { unavailable: "Cancelled after append; inspect status" }
				: !result.writable
					? {
							unavailable: result.appendUncertain
								? "Append uncertain; writes locked"
								: "History read-only; inspect status",
						}
					: {}),
		};
		onUpdate(summary);
	};
	const runtime = new EvidenceRuntimeV2(
		(type, data) => pi.appendEntry(type, data),
		(result) => {
			if (result.action !== "archive") publish(result);
		},
	);
	const valid = (ctx: ExtensionContext) =>
		context?.sessionManager === ctx.sessionManager &&
		context.cwd === ctx.cwd &&
		sessionId === ctx.sessionManager.getSessionId();
	const refresh = async (ctx: ExtensionContext, check = false) => {
		if (!valid(ctx)) return;
		const epoch = generation;
		try {
			const result = await runtime.execute({ action: check ? "check" : "list" }, ctx.signal);
			if (epoch === generation && valid(ctx)) publish(result);
		} catch {
			if (epoch === generation && valid(ctx)) {
				summary = { ...summary, unavailable: "Evidence check unavailable" };
				onUpdate(summary);
			}
		}
	};
	const start = async (event: { reason?: SessionStartEvent["reason"]; type?: string }, ctx: ExtensionContext) => {
		generation++;
		pendingPreview = undefined;
		context = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		const freshSession =
			event.reason === "new" &&
			ctx.sessionManager
				.getEntries()
				.every(
					(entry) =>
						entry.type === "custom" ||
						entry.type === "session_info" ||
						entry.type === "model_change" ||
						entry.type === "thinking_level_change",
				);
		runtime.start(ctx, { freshSession, navigation: event.type === "session_tree" });
		summary = { ...new EvidenceLedger().summary(), unavailable: "Loading evidence" };
		onUpdate(summary);
		await refresh(ctx);
	};
	pi.on("session_start", start);
	pi.on("session_tree", start);
	pi.on("session_shutdown", () => {
		generation++;
		pendingPreview = undefined;
		context = undefined;
		sessionId = undefined;
		runtime.stop();
	});
	pi.on("tool_call", (event, ctx) => {
		if (valid(ctx)) runtime.observeStart(event.toolCallId, event.toolName);
	});
	pi.on("tool_result", async (event, ctx) => {
		if (!valid(ctx)) return;
		const epoch = generation;
		try {
			await runtime.observeResult(event);
		} catch (error) {
			if (epoch === generation && valid(ctx)) {
				summary = { ...summary, unavailable: "Evidence observation unavailable" };
				onUpdate(summary);
				throw error;
			}
		}
	});
	pi.on("agent_end", (_event, ctx) => refresh(ctx, true));
	pi.on("session_compact", (_event, ctx) => refresh(ctx, true));
	pi.registerTool({
		name: TOOL_NAME,
		label: "Evidence ledger",
		description:
			"Local branch-aware evidence, claims and decision-changing gaps; not independent verification. " +
			"list is paginated newest first; use id to inspect. add evidence requires a project file path and bounded " +
			"startLine/endLine; add claim requires active evidence refs. add gap records an unanswered question. " +
			"New v3 sessions accept concerns for add gap and resolvedBy for resolve, separate from claim-support refs. " +
			"Use explicit relationships or refs, not both. Existing sessions retain legacy semantics and reject new relationship fields. " +
			"V3 records expose reviewReasons (up to eight) and sticky reviewOverflow; resolving never clears review. " +
			"Correct with supersedes; retract requires id/reason; resolve requires gap id/reason and active evidence refs. " +
			"check detects tracked source changes; review never clears automatically. Current claims require reassessment " +
			"after shell/edit/write or navigation. Passive receipts are observations, not correctness proofs. " +
			"Results report write locks and committed prefixes after cancellation. preview requires selected IDs (explicit [] carries none); " +
			"it preserves dependency closure and returns carry/omission/review pages and a token. Only the user can commit via " +
			"/midnight evidence commit <token> after confirmation. Never call commit or recover as tool actions. " +
			"archive takes the preview predecessor locator or a continuation cursor, with offset/limit; historical lookup is not live freshness. " +
			"audit requires 1-20 selected claim IDs; read-only bounded support/concern and file-hash assessment, not semantic verification. " +
			"Audit findings paginate with offset/limit; inspect total/nextOffset, availability, legacy limitations and receipts. It never clears review. " +
			"Do not store secrets. No provider calls, uploads or context injection. Use for substantial investigations.",
		parameters: PublicEvidenceParams,
		outputSchema: PublicEvidenceResultSchema,
		executionMode: "sequential",
		namespace: { name: "midnight", description: "Local investigation evidence and advisory log triage" },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_id, params, signal, _update, ctx) {
			if (!valid(ctx)) throw new Error("Evidence session changed.");
			const epoch = generation;
			const result =
				params.action === "audit"
					? await runtime.audit(params, signal)
					: params.action === "preview"
						? await runtime.previewRollover(params.selected, params, signal)
						: params.action === "archive"
							? await runtime.archive(params.locator, params, signal)
							: await runtime.execute(params, signal);
			if (epoch !== generation || !valid(ctx)) throw new Error("Evidence session changed.");
			if (result.action !== "archive" && result.action !== "audit") {
				if (result.action === "preview") pendingPreview = result.preview;
				publish(result);
			}
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, structuredContent: result };
		},
	});
	return {
		get active() {
			return confirming;
		},
		check: (ctx: ExtensionContext) => refresh(ctx, true),
		summary: () => summary,
		async command(args: string, ctx: ExtensionContext) {
			const [action = "status", id, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (!["status", "check", "show", "preview", "commit", "recover"].includes(action)) {
				ctx.ui.notify(
					"/midnight evidence [status|check|show <id>|preview <ids...>|preview --empty|commit <token>|recover]",
					"info",
				);
				return;
			}
			const epoch = generation;
			try {
				if (!valid(ctx)) throw new Error("Evidence session changed.");
				if (action === "commit" || action === "recover") {
					if (rest.length || (action === "recover" && id)) throw new Error("Unexpected evidence command arguments.");
					if (ctx.mode !== "tui" || !ctx.hasUI || !ctx.isIdle())
						throw new Error("Evidence commit/recovery requires an idle interactive TUI session.");
					if (confirming) throw new Error("An evidence confirmation is already open.");
					const preview = pendingPreview;
					if (action === "commit" && (!preview || preview.token !== id))
						throw new Error("Preview expired or token missing; prepare a fresh preview first.");
					if (!beforeDialog()) throw new Error("Finish the active dialog before confirming evidence changes.");
					const leaf = ctx.sessionManager.getLeafId();
					confirming = true;
					try {
						const message =
							action === "commit" && preview
								? [
										`Carry ${preview.carried} records (${preview.bytes} bytes); ${preview.freeSlots} free slots.`,
										`${preview.omitted.total} active records omitted; ${preview.review.total} carried records need review.`,
										"Omitted records remain historical, not resolved. Carried sources are not freshly captured.",
										...preview.warnings,
										"Never reopen this migrated branch with an older/v1 Midnight writer, including passive writes.",
										"This append cannot be undone by cancelling afterward. Review paginated preview results before confirming.",
									].join("\n")
								: "Re-read this branch and unlock only if valid. This does not undo or retry an append, repair history, or clear review flags.";
						const accepted = await ctx.ui.confirm(
							action === "commit" ? "Commit evidence rollover?" : "Recover evidence append lock?",
							message,
						);
						if (epoch !== generation || !valid(ctx)) return;
						if (!accepted) {
							ctx.ui.notify("Evidence operation cancelled; nothing committed by this command.", "info");
							return;
						}
						if (!ctx.isIdle() || ctx.sessionManager.getLeafId() !== leaf)
							throw new Error("Session became busy or branch changed during confirmation; review again.");
						const result =
							action === "commit" ? await runtime.commit(id, ctx.signal) : await runtime.recover(ctx.signal);
						if (epoch !== generation || !valid(ctx)) return;
						pendingPreview = undefined;
						publish(result);
						ctx.ui.notify(formatEvidenceResult(result) ?? "Evidence operation complete", "info");
					} finally {
						confirming = false;
					}
					return;
				}
				if (action === "preview" && (!id || (id === "--empty" && rest.length)))
					throw new Error("Use preview <ids...> or preview --empty to explicitly carry nothing.");
				const result =
					action === "preview"
						? await runtime.previewRollover(id === "--empty" ? [] : [id, ...rest], {}, ctx.signal)
						: await runtime.execute({ action: action === "check" ? "check" : "list", id, limit: 10 }, ctx.signal);
				if (epoch !== generation || !valid(ctx)) return;
				publish(result);
				if (result.preview) pendingPreview = result.preview;
				const lines = [formatEvidenceResult(result) ?? "Evidence unavailable", result.warning];
				if (result.writable)
					lines.unshift(
						`Evidence: ${result.summary.evidence} · claims: ${result.summary.claims} · review: ${result.summary.review} · gaps: ${result.summary.gaps}`,
					);
				if (result.preview) lines.push(JSON.stringify(result));
				if (action === "show")
					for (const { record } of result.records) {
						lines.push(
							`${record.id} [${record.kind}/${record.status}] ${record.text}${record.review ? ` — REVIEW: ${record.review}` : ""}`,
						);
						if ("semantics" in record) {
							for (const cause of record.reviewReasons)
								lines.push(`  ${cause.code}${cause.dependency ? ` (${cause.dependency})` : ""}: ${cause.explanation}`);
							if (record.reviewOverflow) lines.push("  Additional review causes omitted; reassessment still required.");
							if (record.kind === "gap")
								lines.push(
									`  concerns: ${(record.concerns ?? []).join(", ")} · resolvedBy: ${(record.resolvedBy ?? []).join(", ")}`,
								);
						}
					}
				if (result.issue) lines.push(result.issue);
				ctx.ui.notify(
					stripTerminalSequences(lines.join("\n"))
						.replace(/[^\S\n]+/gu, " ")
						.replace(/[\p{Cc}]/gu, (c) => (c === "\n" ? c : " ")),
					"info",
				);
			} catch (error) {
				if (epoch === generation && valid(ctx))
					ctx.ui.notify(stripTerminalSequences(error instanceof Error ? error.message : String(error)), "warning");
			}
		},
	};
}
