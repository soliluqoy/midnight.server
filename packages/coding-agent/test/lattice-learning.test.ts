import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mineAbstractions } from "../src/lattice/abstraction.ts";
import { canonical } from "../src/lattice/canonical.ts";
import {
	type Contract,
	inventoryReport,
	organizePlan,
	RECORD_TYPE,
	recordFixture,
	recordsFilter,
	recordsFilterProgram,
} from "../src/lattice/contracts.ts";
import { evaluateCase, evaluateSuite } from "../src/lattice/evaluator.ts";
import { economicGate, ucbSelect } from "../src/lattice/governor.ts";
import { interpret } from "../src/lattice/interpreter.ts";
import { type Expr, IR_VERSION, type Program, T, type Value } from "../src/lattice/ir.ts";
import { Lattice } from "../src/lattice/kernel.ts";
import { INSTALLATION_LIMITS } from "../src/lattice/limits.ts";
import { metaTasks, proposePolicies, RANDOM_POLICY, scorePolicy } from "../src/lattice/metapolicy.ts";
import { EVIDENCE_ONLY, enumerateMutations, MUTATION_OPS } from "../src/lattice/mutate.ts";
import { PyRandom } from "../src/lattice/random.ts";
import { clampPolicy, DEFAULT_POLICY, makeVerifier, searchImprovement, shrink } from "../src/lattice/search.ts";
import { type ExampleTask, synthesize, taskProgram } from "../src/lattice/synthesis.ts";
import { checkProgram } from "../src/lattice/typecheck.ts";

const context = { limits: INSTALLATION_LIMITS, library: new Map() };
const info = (program: Program, contract: Contract) => {
	const check = checkProgram(program, {
		limits: INSTALLATION_LIMITS,
		granted: new Set(),
		library: new Map(),
		inputSummary: contract.inputBounds,
	});
	if (!check.ok) throw new Error(check.error);
	return check.info;
};

describe("lattice mutation operators", () => {
	const all = new Set(MUTATION_OPS);

	for (const contract of [inventoryReport, recordsFilter, organizePlan]) {
		it(`preserves ${contract.id} semantics for every operator with a provable precondition`, () => {
			const program = contract.seed();
			const inputs = [
				...contract.fixtures.development().slice(0, 2),
				...contract.fixtures.regression(),
				...Array.from({ length: 5 }, (_, i) => contract.fuzz!(new PyRandom(i))),
			];
			const expected = inputs.map((input) => canonical(contract.oracle(input)));
			const mutations = enumerateMutations(program, info(program, contract), all);
			expect(mutations.length).toBeGreaterThan(3);
			for (const mutation of mutations) {
				if (EVIDENCE_ONLY.has(mutation.op)) continue;
				expect(
					checkProgram(mutation.program, {
						limits: INSTALLATION_LIMITS,
						granted: new Set(),
						library: new Map(),
						inputSummary: contract.inputBounds,
					}).ok,
				).toBe(true);
				inputs.forEach((input, index) => {
					const run = interpret(mutation.program, input, context);
					expect(run.ok && canonical(run.value), `${mutation.description}`).toBe(expected[index]);
				});
			}
		});
	}

	it("does not reorder branches whose conditions can both hold", () => {
		const x: Expr = { node: "var", name: "x" };
		const eq = (value: string): Expr => ({
			node: "call",
			op: "eq",
			args: [x, { node: "const", type: T.string, value }],
		});
		const s = (value: string): Expr => ({ node: "const", type: T.string, value });
		const program = (second: Expr): Program => ({
			ir_version: IR_VERSION,
			input_type: T.string,
			output_type: T.string,
			body: {
				node: "let",
				name: "x",
				value: { node: "input" },
				body: {
					node: "if",
					cond: eq("a"),
					ifTrue: s("A"),
					ifFalse: { node: "if", cond: second, ifTrue: s("B"), ifFalse: s("-") },
				},
			},
		});
		const overlapping = program({ node: "or", args: [eq("a"), eq("b")] });
		const disjoint = program(eq("b"));
		const options = {
			limits: INSTALLATION_LIMITS,
			granted: new Set<never>(),
			library: new Map(),
			inputSummary: { bytes: 10 },
		};
		const ops = (p: Program) => {
			const check = checkProgram(p, options);
			if (!check.ok) throw new Error(check.error);
			return enumerateMutations(p, check.info, new Set(["reorder_exclusive"] as const)).length;
		};
		expect(ops(overlapping)).toBe(0);
		expect(ops(disjoint)).toBe(1);
	});

	it("hoists repeated work only when the expression cannot fail", () => {
		const repeated = (inner: Expr): Program => ({
			ir_version: IR_VERSION,
			input_type: T.list(T.int),
			output_type: T.list(T.int),
			body: { node: "record", fields: { a: inner, b: inner } } as Expr,
		});
		const total: Expr = {
			node: "call",
			op: "sum",
			args: [
				{
					node: "map",
					list: { node: "input" },
					param: "v",
					body: {
						node: "call",
						op: "add",
						args: [
							{ node: "var", name: "v" },
							{ node: "const", type: T.int, value: 1 },
						],
					},
					maxItems: 8,
				},
			],
		};
		const partial: Expr = {
			node: "fold",
			list: { node: "input" },
			init: { node: "const", type: T.int, value: 0 },
			item: "v",
			acc: "t",
			body: {
				node: "call",
				op: "add",
				args: [
					{ node: "var", name: "t" },
					{ node: "var", name: "v" },
				],
			},
			maxItems: 8,
		};
		const count = (inner: Expr) => {
			const program = { ...repeated(inner), output_type: T.record({ a: T.int, b: T.int }) };
			const check = checkProgram(program, {
				limits: INSTALLATION_LIMITS,
				granted: new Set(),
				library: new Map(),
				inputSummary: { card: 8, item: { mag: 100 } },
			});
			if (!check.ok) throw new Error(check.error);
			return enumerateMutations(program, check.info, new Set(["hoist_common"] as const)).length;
		};
		expect(count(total)).toBe(1);
		expect(count(partial)).toBe(0);
	});

	it("rejects an unprovable proposal with a shrunk counterexample", () => {
		const dropped = recordsFilterProgram(["is_log", "old_enough", "size_positive", "text_hit"]);
		const verifier = makeVerifier(recordsFilter, context, recordsFilter.fuzz!, { seed: 3, trials: 16 });
		const failure = verifier(dropped);
		expect(failure).toBeDefined();
		expect((failure!.input as Value[]).length).toBeLessThanOrEqual(2);
		expect(evaluateCase(recordsFilter, dropped, failure!.input, context).correct).toBe(false);
		const big = recordFixture(4);
		const small = shrink(recordsFilter, dropped, big as unknown as Value, context) as Value[];
		expect(small.length).toBeLessThan(big.length);
		expect(evaluateCase(recordsFilter, dropped, small, context).correct).toBe(false);
	});
});

describe("lattice development search", () => {
	it("improves the inventory seed and the result stays correct on unseen release data", () => {
		const report = searchImprovement({
			contract: inventoryReport,
			parent: inventoryReport.seed(),
			costCases: inventoryReport.fixtures.development().slice(0, 3),
			checkCases: inventoryReport.fixtures.regression(),
			policy: { ...DEFAULT_POLICY, max_evaluations: 40 },
			limits: INSTALLATION_LIMITS,
			library: new Map(),
			seed: 8128,
		});
		expect(report.bestCost).toBeLessThan(report.parentCost * 0.7);
		const release = evaluateSuite(
			inventoryReport,
			report.best,
			inventoryReport.fixtures.release(1).slice(0, 4),
			context,
		);
		expect(release.allCorrect).toBe(true);
		expect(report.work).toBeLessThanOrEqual(report.budgetWork + 3_000);
	});
});

describe("lattice library learning and synthesis (milestone M7)", () => {
	const r: Expr = { node: "var", name: "r" };
	const field = (name: string): Expr => ({ node: "field", record: r, name });
	const target = (ext: string, age: number): Expr => ({
		node: "and",
		args: [
			{ node: "call", op: "eq", args: [field("ext"), { node: "const", type: T.string, value: ext }] },
			{ node: "call", op: "ge", args: [field("age"), { node: "const", type: T.int, value: age }] },
			{ node: "call", op: "not", args: [field("hidden")] },
		],
	});
	const task = (name: string, ext: string, age: number, seed: number): ExampleTask => {
		const rng = new PyRandom(seed);
		const examples = Array.from({ length: 6 }, () => {
			const rows = Array.from({ length: 30 }, (_, id) => ({
				id,
				text: rng.choice(["ok", "ERROR x", "warn"]),
				size: rng.choice([0, 1, 10]),
				hidden: rng.random() < 0.3,
				ext: rng.choice(["log", "txt", "csv", "md"]),
				age: rng.randrange(40),
			}));
			return {
				input: rows as unknown as Value,
				output: rows.filter((row) => row.ext === ext && row.age >= age && !row.hidden).map((row) => row.id),
			};
		});
		return { name, recordType: RECORD_TYPE, idField: "id", examples };
	};

	it("mines a verified abstraction that makes held-out synthesis succeed under an equal budget", () => {
		const training: [string, number][] = [
			["log", 14],
			["csv", 20],
			["md", 7],
		];
		const corpus = training.map(([ext, age], i) => {
			const t = task(`t${i}`, ext, age, 100 + i);
			return {
				id: t.name,
				program: taskProgram(t, target(ext, age)),
				inputBounds: {},
				cases: t.examples.map((example) => example.input),
			};
		});
		const mined = mineAbstractions(corpus, { limits: INSTALLATION_LIMITS, library: new Map() });
		expect(mined).toHaveLength(1);
		expect(mined[0].skill.params).toHaveLength(3);
		expect(mined[0].occurrences).toBe(3);
		expect(mined[0].gain).toBeGreaterThan(0);
		expect(mined[0].verifiedCases).toBe(18);
		const library = new Map([[mined[0].hash, mined[0].skill]]);
		const heldOut: [string, number][] = [
			["txt", 25],
			["log", 5],
			["csv", 31],
			["md", 18],
		];
		const budget = { limits: INSTALLATION_LIMITS, maxCandidates: 20_000, maxSize: 7 };
		for (const [index, [ext, age]] of heldOut.entries()) {
			const t = task(`h${index}`, ext, age, 200 + index);
			const without = synthesize(t, { ...budget, library: new Map() });
			const withLibrary = synthesize(t, { ...budget, library });
			expect(without.found).toBe(false);
			expect(withLibrary.found).toBe(true);
			expect(withLibrary.size).toBe(1);
			expect(withLibrary.heldout.passed).toBe(withLibrary.heldout.total);
			expect(withLibrary.enumerated).toBeLessThan(1_000);
		}
	});

	it("turns a failing held-out example into development evidence (counterexample-guided)", () => {
		const row = (id: number, ext: string, age: number) => ({ id, text: "", size: 1, hidden: false, ext, age });
		const pick = (rows: ReturnType<typeof row>[]) =>
			rows.filter((x) => x.ext === "log" && x.age >= 14).map((x) => x.id);
		const sets = [
			[
				row(0, "log", 14),
				row(1, "log", 20),
				row(2, "log", 30),
				row(3, "txt", 1),
				row(4, "txt", 5),
				row(5, "txt", 16),
			],
			[row(0, "log", 5), row(1, "log", 25), row(2, "txt", 14)],
			[row(0, "log", 15), row(1, "log", 39), row(2, "txt", 2)],
			[row(0, "log", 10), row(1, "log", 14), row(2, "txt", 20)],
		];
		const t: ExampleTask = {
			name: "cegis",
			recordType: RECORD_TYPE,
			idField: "id",
			examples: sets.map((rows) => ({ input: rows as unknown as Value, output: pick(rows) })),
		};
		const result = synthesize(t, {
			limits: INSTALLATION_LIMITS,
			library: new Map(),
			maxCandidates: 50_000,
			maxSize: 5,
		});
		expect(result.found).toBe(true);
		expect(result.counterexamples).toBe(2);
		expect(result.heldout.total).toBe(0);
		for (const example of t.examples) {
			const run = interpret(result.program!, example.input, context);
			expect(run.ok && run.value).toEqual(example.output);
		}
	});
});

describe("lattice level-2 policy search", () => {
	it("scores deterministically and keeps proposals inside the governor's limits", () => {
		const tasks = metaTasks("selection", 3);
		const options = { budget: 8, seeds: [1], limits: INSTALLATION_LIMITS, library: new Map() };
		expect(scorePolicy(DEFAULT_POLICY, tasks, options).runs).toEqual(
			scorePolicy(DEFAULT_POLICY, tasks, options).runs,
		);
		const proposals = proposePolicies(DEFAULT_POLICY, new PyRandom(1), 12);
		expect(proposals).toHaveLength(12);
		for (const proposal of proposals) {
			expect(canonical(clampPolicy(proposal))).toBe(canonical(proposal));
			expect(canonical({ ...proposal, policy_revision: 1 })).not.toBe(canonical(DEFAULT_POLICY));
		}
		const greedy = clampPolicy({ ...DEFAULT_POLICY, max_evaluations: 1e9, beam_width: 1_000, screen_width: 1e6 });
		expect([greedy.max_evaluations, greedy.beam_width, greedy.screen_width]).toEqual([256, 16, 256]);
		expect(RANDOM_POLICY.development_test_order).toBe("fixed");
		// Past the research budget the score is abandoned, never computed from truncated runs.
		expect(() => scorePolicy(DEFAULT_POLICY, tasks, { ...options, deadline: performance.now() - 1 })).toThrow(
			/research budget exhausted/,
		);
	});

	it("runs a policy campaign that only promotes with fresh-family evidence", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lattice-policy-"));
		const lattice = Lattice.open(dir);
		try {
			lattice.init({ snapshot: false });
			const before = lattice.policy();
			const report = await lattice.improveSearchPolicy({ proposals: 6, budget: 8, seeds: [1], tasks: 3 });
			expect(["promoted", "rejected", "no_candidate"]).toContain(report.status);
			expect(report.selection.proposals).toHaveLength(6);
			if (report.status === "promoted") {
				expect(report.release!.lower_bound).toBeGreaterThan(0);
				expect(report.release!.candidate.finalCost).toBeLessThanOrEqual(report.release!.parent.finalCost);
				expect(lattice.policy().version).toBe(report.promoted_version);
			} else expect(lattice.policy().version).toBe(before.version);
		} finally {
			lattice.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("lattice economics and selection", () => {
	let dir: string;
	let lattice: Lattice;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lattice-econ-"));
		lattice = Lattice.open(dir);
		lattice.init({ snapshot: false });
	});
	afterEach(() => {
		lattice.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("skips a routine campaign whose expected savings do not pay for the search", async () => {
		expect(
			economicGate({ expectedFutureCalls: 10, unitsPerCall: 100, expectedReduction: 0.5, searchUnits: 10_000 })
				.worthIt,
		).toBe(false);
		expect(
			economicGate({ expectedFutureCalls: 1e6, unitsPerCall: 100, expectedReduction: 0.1, searchUnits: 10_000 })
				.worthIt,
		).toBe(true);
		const report = await lattice.improve("records.filter", { isolate: false });
		expect(report.status).toBe("no_candidate");
		expect((report.diagnosis.economic as { worthIt: boolean }).worthIt).toBe(false);
		expect(lattice.store.auditLog("records.filter", 5).map((entry) => entry.kind)).toContain("campaign_skipped");
	});

	it("tries untried arms first, then prefers the better mean", () => {
		const stats = new Map([
			["a", { trials: 10, reward: 9 }],
			["b", { trials: 10, reward: 2 }],
		]);
		expect(ucbSelect(["a", "b", "c"], stats)).toBe("c");
		expect(ucbSelect(["a", "b"], stats)).toBe("a");
	});
});
