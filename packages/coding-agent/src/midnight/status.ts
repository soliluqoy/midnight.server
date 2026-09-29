/**
 * Process-wide midnight.server state for the interactive UI (sidebar, footer) and the
 * agent-mode extension. One CLI process drives one session, so a module-level store is
 * enough and keeps the UI out of the extensions' constructor wiring.
 */

/** `build`: all tools. `plan`: read-only tools; the model proposes a plan instead of editing. */
export type AgentMode = "build" | "plan";

export interface MidnightStatus {
	agentMode: AgentMode;
}

let status: MidnightStatus = { agentMode: "build" };
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
