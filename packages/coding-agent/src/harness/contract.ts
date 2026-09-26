import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * The task contract: what the user wants, the limits they set, and how to tell the work is
 * done. The model writes it with the `task` tool; the harness keeps it visible and holds the
 * run to its acceptance criteria before settling.
 *
 * Problem it solves: a model that starts editing from a one-line request often optimizes the
 * literal words and misses an implied requirement ("fix the test" when the user meant "fix
 * the bug the test caught"). Writing the objective, constraints and checkable criteria first
 * makes the interpretation explicit and reviewable, and gives the harness something concrete
 * to check completion against, instead of the model's own "done".
 */

export type CriterionStatus = "open" | "met" | "unmet" | "waived";
export type StepStatus = "todo" | "doing" | "done" | "dropped";

export interface Criterion {
	text: string;
	status: CriterionStatus;
	/** Required for met, unmet and waived: what shows it (a command and its result, a file and line). */
	evidence?: string;
}

export interface PlanStep {
	text: string;
	status: StepStatus;
	note?: string;
}

export interface TaskContract {
	version: number;
	objective: string;
	constraints: string[];
	criteria: Criterion[];
	plan: PlanStep[];
}

export interface ContractSetInput {
	objective: string;
	constraints?: string[];
	criteria: string[];
	plan?: string[];
}

export interface ContractUpdateInput {
	criteria?: Array<{ id: number; status: Exclude<CriterionStatus, "open">; evidence: string }>;
	steps?: Array<{ id: number; status: StepStatus; note?: string }>;
	/** Criteria discovered while working. They start open. */
	addCriteria?: string[];
	addSteps?: string[];
}

export class ContractError extends Error {}

function clean(items: readonly string[] | undefined): string[] {
	return (items ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
}

export function createContract(input: ContractSetInput, previous?: TaskContract): TaskContract {
	const objective = input.objective.trim();
	if (!objective) throw new ContractError("objective must not be empty");
	const criteria = clean(input.criteria);
	if (criteria.length === 0) throw new ContractError("give at least one acceptance criterion");
	return {
		version: (previous?.version ?? 0) + 1,
		objective,
		constraints: clean(input.constraints),
		criteria: criteria.map((text) => ({ text, status: "open" })),
		plan: clean(input.plan).map((text) => ({ text, status: "todo" })),
	};
}

export function updateContract(contract: TaskContract, input: ContractUpdateInput): TaskContract {
	const next: TaskContract = {
		...contract,
		version: contract.version + 1,
		criteria: contract.criteria.map((criterion) => ({ ...criterion })),
		plan: contract.plan.map((step) => ({ ...step })),
	};
	for (const change of input.criteria ?? []) {
		const criterion = next.criteria[change.id - 1];
		if (!criterion) throw new ContractError(`no criterion ${change.id}; there are ${next.criteria.length}`);
		const evidence = change.evidence.trim();
		if (!evidence) throw new ContractError(`criterion ${change.id}: evidence is required`);
		criterion.status = change.status;
		criterion.evidence = evidence;
	}
	for (const change of input.steps ?? []) {
		const step = next.plan[change.id - 1];
		if (!step) throw new ContractError(`no plan step ${change.id}; there are ${next.plan.length}`);
		step.status = change.status;
		step.note = change.note?.trim() || undefined;
	}
	for (const text of clean(input.addCriteria)) next.criteria.push({ text, status: "open" });
	for (const text of clean(input.addSteps)) next.plan.push({ text, status: "todo" });
	return next;
}

/** Criteria that still block completion: not yet shown met, and not explicitly waived. */
export function openCriteria(contract: TaskContract): Array<{ id: number; criterion: Criterion }> {
	return contract.criteria.flatMap((criterion, index) =>
		criterion.status === "open" || criterion.status === "unmet" ? [{ id: index + 1, criterion }] : [],
	);
}

const CRITERION_MARK: Record<CriterionStatus, string> = { open: "[ ]", met: "[x]", unmet: "[!]", waived: "[-]" };

export function formatContract(contract: TaskContract): string {
	const lines = [`Task contract v${contract.version}`, `Objective: ${contract.objective}`];
	if (contract.constraints.length > 0) {
		lines.push("Constraints:");
		for (const constraint of contract.constraints) lines.push(`- ${constraint}`);
	}
	lines.push("Acceptance criteria ([x] met, [!] unmet, [-] waived, [ ] open):");
	contract.criteria.forEach((criterion, index) => {
		const evidence = criterion.evidence ? ` (${criterion.evidence})` : "";
		lines.push(`${CRITERION_MARK[criterion.status]} ${index + 1}. ${criterion.text}${evidence}`);
	});
	if (contract.plan.length > 0) {
		lines.push("Plan:");
		contract.plan.forEach((step, index) => {
			lines.push(`${index + 1}. [${step.status}] ${step.text}${step.note ? ` (${step.note})` : ""}`);
		});
	}
	return lines.join("\n");
}

export const TASK_TOOL_NAME = "task";

function isContract(value: unknown): value is TaskContract {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.objective === "string" && Array.isArray(record.criteria) && typeof record.version === "number";
}

/**
 * The newest contract in a message list. The contract lives in the `task` tool results'
 * details, so it follows the session tree: branching back with /tree restores the contract
 * that was current at that point, with no separate state to keep in sync.
 */
export function latestContract(messages: readonly AgentMessage[]): TaskContract | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "toolResult" || message.toolName !== TASK_TOOL_NAME || message.isError) continue;
		const details = (message as { details?: unknown }).details;
		if (isContract(details)) return details;
	}
	return undefined;
}
