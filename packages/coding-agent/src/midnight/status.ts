/**
 * Process-wide midnight.server state for the interactive UI (header, footer, sidebar).
 * The local runtime, engine manager and drift watcher write it; the UI only reads it
 * and re-renders on change. One CLI process drives one session, so a module-level
 * store is enough and keeps the UI out of the runtime's constructor wiring.
 */

/** `hybrid`: a cloud provider leads. `local`: --local. `fallback`: no provider configured, local model leads. */
export type MidnightSessionMode = "hybrid" | "local" | "fallback";

/** `off`: not started (it starts on first use). `unavailable`: setup failed; features that need it are disabled. */
export type LocalEngineState = "off" | "starting" | "ready" | "unavailable";

export type DriftVerdictStatus = "on_track" | "drifting" | "off_task";

export interface DriftWatchState {
	checking: boolean;
	lastVerdict?: DriftVerdictStatus;
	/** Assistant turns left before the next scheduled check. */
	turnsUntilCheck: number;
}

/** `build`: all tools. `plan`: read-only tools; the model proposes a plan instead of editing. */
export type AgentMode = "build" | "plan";

export interface MidnightStatus {
	mode?: MidnightSessionMode;
	engine: LocalEngineState;
	/** Undefined when drift watch is disabled or not active in this mode. */
	drift?: DriftWatchState;
	agentMode: AgentMode;
}

let status: MidnightStatus = { engine: "off", agentMode: "build" };
const listeners = new Set<() => void>();

export function getMidnightStatus(): Readonly<MidnightStatus> {
	return status;
}

export function updateMidnightStatus(patch: Partial<MidnightStatus>): void {
	status = { ...status, ...patch };
	for (const listener of listeners) listener();
}

/** Returns an unsubscribe function. */
export function onMidnightStatusChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
