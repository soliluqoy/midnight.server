import { appendFileSync, statSync } from "node:fs";

/**
 * What the harness decided, for `/harness` and for the eval. Counts stay in memory. When
 * `MIDNIGHT_SERVER_HARNESS_TELEMETRY` names a file, each event is also appended to it as one
 * JSON line (the eval sets it per run). Nothing is sent anywhere.
 */
export interface HarnessEvent {
	type: string;
	[key: string]: unknown;
}

const MAX_LOG_BYTES = 20_000_000;

export class HarnessTelemetry {
	readonly counts = new Map<string, number>();
	private readonly path: string | undefined;

	constructor(path = process.env.MIDNIGHT_SERVER_HARNESS_TELEMETRY) {
		this.path = path || undefined;
	}

	record(event: HarnessEvent): void {
		this.counts.set(event.type, (this.counts.get(event.type) ?? 0) + 1);
		if (!this.path) return;
		try {
			let size = 0;
			try {
				size = statSync(this.path).size;
			} catch {
				// Not created yet.
			}
			if (size > MAX_LOG_BYTES) return;
			appendFileSync(this.path, `${JSON.stringify({ time: Date.now(), ...event })}\n`);
		} catch {
			// Telemetry must never break a run.
		}
	}

	count(type: string): number {
		return this.counts.get(type) ?? 0;
	}

	summary(): string {
		if (this.counts.size === 0) return "none yet";
		return [...this.counts.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([type, count]) => `${type} ${count}`)
			.join(", ");
	}
}
