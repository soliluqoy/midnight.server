import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionFileChanges } from "./session-file-changes.ts";
import { sessionTitleUsage } from "./session-title.ts";

type Manager = ExtensionContext["sessionManager"];

/** Pi 1.0.4 can count entries without a scan, but its read-only type leaves this method out. */
export function sessionEntryCount(manager: Manager): number | undefined {
	const getter: unknown = Reflect.get(manager, "getEntryCount");
	if (typeof getter !== "function") return undefined;
	const count: unknown = Reflect.apply(getter, manager, []);
	return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/** Read only new entries when they are added. Rebuild after a branch or session change. */
export class SessionAnalysis {
	totals = { input: 0, output: 0, cost: 0 };
	private manager: Manager | undefined;
	private sessionId: string | undefined;
	private cwd = "";
	private count: number | undefined;
	private leaf: string | null = null;
	private files = new SessionFileChanges("");

	get changes() {
		return this.files.snapshot();
	}

	update(manager: Manager, cwd: string): void {
		const count = sessionEntryCount(manager);
		const leaf = manager.getLeafId();
		const sessionId = manager.getSessionId();
		const sameSession = this.manager === manager && this.sessionId === sessionId && this.cwd === cwd;
		if (sameSession && this.count === count && this.leaf === leaf) return;
		const appended: SessionEntry[] = [];
		let cursor = leaf;
		if (sameSession && count !== undefined && this.count !== undefined && count >= this.count) {
			while (cursor !== this.leaf && cursor !== null && appended.length <= count - this.count) {
				const entry = manager.getEntry(cursor);
				if (!entry) break;
				appended.push(entry);
				cursor = entry.parentId;
			}
		}
		// Totals include old branches too, not just the one we are on.
		const incremental =
			sameSession &&
			count !== undefined &&
			this.count !== undefined &&
			cursor === this.leaf &&
			appended.length === count - this.count;
		if (!incremental) {
			this.totals = { input: 0, output: 0, cost: 0 };
			for (const entry of manager.getEntries()) this.addUsage(entry);
			this.files = new SessionFileChanges(cwd);
			for (const entry of manager.getBranch()) this.files.append(entry);
		} else {
			for (const entry of appended.reverse()) {
				this.addUsage(entry);
				this.files.append(entry);
			}
		}
		this.manager = manager;
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.count = count;
		this.leaf = leaf;
	}

	private addUsage(entry: SessionEntry): void {
		const usage =
			entry.type === "usage"
				? entry.usage
				: entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
					? entry.message.usage
					: entry.type === "compaction" || entry.type === "branch_summary"
						? entry.usage
						: sessionTitleUsage(entry);
		if (!usage) return;
		this.totals.input += usage.input;
		this.totals.output += usage.output;
		this.totals.cost += usage.cost.total;
	}
}
