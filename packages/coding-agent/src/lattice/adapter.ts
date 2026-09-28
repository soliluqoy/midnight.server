/**
 * Optional goal adapters (spec section 16). An adapter turns free text into a proposed structured
 * goal; its output is untrusted (trust level T4): the kernel validates it, asks for clarification
 * when fields are missing or uncertain, and never lets it perform an action. The kernel works with
 * no adapter at all: structured goals (contract plus input) bypass this layer.
 *
 * The built-in adapter is a set of exact task templates, not a model (section 37.2).
 */
export interface ProposedGoal {
	contract_id?: string;
	directory?: string;
	input_file?: string;
}

export interface AdapterOutput {
	goal: ProposedGoal;
	confidence: number;
	uncertainties: string[];
	adapter: string;
}

export interface GoalAdapter {
	id: string;
	propose(text: string): AdapterOutput;
}

const TEMPLATES: { pattern: RegExp; build(match: RegExpMatchArray): ProposedGoal }[] = [
	{
		pattern:
			/^(?:inventory|report on|summari[sz]e|organi[sz]e report for)\s+(?:the\s+)?(?:folder\s+|directory\s+)?(?<path>"[^"]+"|\S+)\s*$/i,
		build: (match) => ({ contract_id: "inventory.report", directory: unquote(match.groups?.path) }),
	},
	{
		pattern: /^(?:inventory|report|summary)\s*$/i,
		build: () => ({ contract_id: "inventory.report" }),
	},
	{
		pattern: /^filter\s+(?:error\s+)?records\s+(?:in|from)\s+(?<path>"[^"]+"|\S+)\s*$/i,
		build: (match) => ({ contract_id: "records.filter", input_file: unquote(match.groups?.path) }),
	},
];

function unquote(value: string | undefined): string | undefined {
	return value?.replace(/^"(.*)"$/, "$1");
}

export const templateAdapter: GoalAdapter = {
	id: "templates-v1",
	propose(text: string): AdapterOutput {
		for (const template of TEMPLATES) {
			const match = text.trim().match(template.pattern);
			if (!match) continue;
			const goal = template.build(match);
			const uncertainties: string[] = [];
			if (goal.contract_id === "inventory.report" && !goal.directory)
				uncertainties.push("which directory should be inventoried?");
			if (goal.contract_id === "records.filter" && !goal.input_file)
				uncertainties.push("which records file should be filtered?");
			return { goal, confidence: uncertainties.length === 0 ? 1 : 0.5, uncertainties, adapter: this.id };
		}
		return {
			goal: {},
			confidence: 0,
			uncertainties: [
				'no task template matches; try "inventory <directory>" or "filter records in <file.json>", or pass --contract',
			],
			adapter: this.id,
		};
	},
};
