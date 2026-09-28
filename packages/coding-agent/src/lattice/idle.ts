import type { CampaignReport } from "./campaign.ts";
import type { Lattice } from "./kernel.ts";
import { POLICY_SKILL } from "./metapolicy.ts";
import type { KernelLoop } from "./server.ts";

/**
 * Energy-aware scheduling (spec sections 14.3 and 22.3). Interactive work always goes first; the
 * scheduler starts improvement only after the loop has been idle for `idleMs`, one campaign at a
 * time, in the background lane (so an interactive request pauses it with a checkpoint). Paused
 * campaigns resume before new ones start. New campaigns pass the economic gate. A campaign that
 * produces nothing, or fails, backs its skill off exponentially. Maintenance runs only when
 * enabled, at most once per `maintenanceEveryMs`.
 */
export interface IdleOptions {
	idleMs: number;
	/** How often to look for idle time. */
	checkEveryMs?: number;
	baseBackoffMs?: number;
	maxBackoffMs?: number;
	maintenance?: boolean;
	maintenanceEveryMs?: number;
}

export interface IdleDecision {
	action: "none" | "resume" | "improve" | "maintenance";
	skill?: string;
	campaign?: string;
	outcome?: string;
	reason?: string;
}

interface Backoff {
	until: number;
	ms: number;
}

export class IdleScheduler {
	private readonly lattice: Lattice;
	private readonly loop: KernelLoop;
	private readonly options: Required<IdleOptions>;
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	readonly decisions: IdleDecision[] = [];

	constructor(lattice: Lattice, loop: KernelLoop, options: IdleOptions) {
		this.lattice = lattice;
		this.loop = loop;
		this.options = {
			checkEveryMs: 30_000,
			baseBackoffMs: 3_600_000,
			maxBackoffMs: 24 * 3_600_000,
			maintenance: false,
			maintenanceEveryMs: 24 * 3_600_000,
			...options,
		};
	}

	start(): void {
		this.timer ??= setInterval(() => void this.tick(), this.options.checkEveryMs);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private backoff(skill: string): Backoff | undefined {
		const raw = this.lattice.store.getMeta(`backoff:${skill}`);
		return raw ? (JSON.parse(raw) as Backoff) : undefined;
	}

	private setBackoff(skill: string, success: boolean): void {
		if (success) {
			this.lattice.store.setMeta(`backoff:${skill}`, JSON.stringify({ until: 0, ms: 0 }));
			return;
		}
		const previous = this.backoff(skill)?.ms ?? 0;
		const ms = Math.min(this.options.maxBackoffMs, previous > 0 ? previous * 2 : this.options.baseBackoffMs);
		this.lattice.store.setMeta(`backoff:${skill}`, JSON.stringify({ until: Date.now() + ms, ms }));
	}

	/** One scheduling decision. Returns what was done; exposed for tests and `lattice status`. */
	async tick(): Promise<IdleDecision> {
		const decide = (decision: IdleDecision) => {
			this.decisions.push(decision);
			if (this.decisions.length > 100) this.decisions.shift();
			return decision;
		};
		if (this.running || !this.loop.idle) return { action: "none", reason: "busy" };
		if (performance.now() - this.loop.lastInteractiveAt < this.options.idleMs)
			return { action: "none", reason: "not idle long enough" };
		this.running = true;
		try {
			const store = this.lattice.store;
			if (this.options.maintenance) {
				const last = Number(store.getMeta("maintenance_at") ?? "0");
				if (Date.now() - last >= this.options.maintenanceEveryMs) {
					store.setMeta("maintenance_at", String(Date.now()));
					await this.loop.submit(false, async () => this.lattice.maintenance());
					return decide({ action: "maintenance" });
				}
			}
			const skills = store
				.skills()
				.map((row) => row.skill_id)
				.filter((skill) => skill !== POLICY_SKILL && !skill.startsWith("user."));
			// Paused campaigns first: their population is already paid for.
			for (const skill of skills) {
				const paused = store.campaigns(skill).find((campaign) => campaign.status === "paused");
				if (!paused) continue;
				const report = await this.run(skill, paused.campaign_id);
				return decide({ action: "resume", skill, campaign: paused.campaign_id, ...report });
			}
			const now = Date.now();
			const ready = skills.filter((skill) => (this.backoff(skill)?.until ?? 0) <= now);
			if (ready.length === 0) return decide({ action: "none", reason: "every skill is backing off" });
			// Least recently improved first.
			const last = (skill: string) => store.campaigns(skill).at(-1)?.created_at ?? 0;
			const skill = ready.sort((a, b) => last(a) - last(b) || a.localeCompare(b))[0];
			return decide({ action: "improve", skill, ...(await this.run(skill)) });
		} finally {
			this.running = false;
		}
	}

	private async run(skill: string, resume?: string): Promise<{ campaign?: string; outcome: string; reason?: string }> {
		try {
			const report = await this.loop.submit(
				false,
				(signal): Promise<CampaignReport> =>
					this.lattice.improve(skill, { explore: false, isolate: true, signal, resume }),
			);
			// A pause is neither success nor failure: the campaign resumes next idle period.
			if (report.status !== "paused") this.setBackoff(skill, report.status === "promoted");
			const reason =
				report.status === "no_candidate" && report.diagnosis.economic
					? "economic gate: not worth searching yet"
					: undefined;
			return { campaign: report.campaign_id, outcome: report.status, reason };
		} catch (error) {
			this.setBackoff(skill, false);
			return { outcome: "error", reason: error instanceof Error ? error.message : String(error) };
		}
	}
}
