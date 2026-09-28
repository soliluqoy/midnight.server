import { describe, expect, it } from "vitest";
import { canonical } from "../src/lattice/canonical.ts";
import { compileProgram, differential, runBytecode, verifyBytecode } from "../src/lattice/compile.ts";
import {
	inventoryReport,
	RECORD_BASELINE,
	recordBoundaryFixture,
	recordsFilter,
	recordsFilterProgram,
} from "../src/lattice/contracts.ts";
import {
	alphaForCampaign,
	bootstrapLowerBound,
	evaluateSuite,
	pairedGains,
	releaseGate,
} from "../src/lattice/evaluator.ts";
import { interpret } from "../src/lattice/interpreter.ts";
import { type Expr, IR_VERSION, type Program, programHash, T, type Value } from "../src/lattice/ir.ts";
import { permutations } from "../src/lattice/kernel.ts";
import { INSTALLATION_LIMITS } from "../src/lattice/limits.ts";
import { PRIMITIVE_LIBRARY_HASH } from "../src/lattice/primitives.ts";
import { PyRandom } from "../src/lattice/random.ts";
import { REFERENCE_POLICY, searchImprovement } from "../src/lattice/search.ts";
import { checkProgram } from "../src/lattice/typecheck.ts";

const context = { limits: INSTALLATION_LIMITS, library: new Map() };
const checkOptions = {
	limits: INSTALLATION_LIMITS,
	granted: new Set<never>(),
	library: new Map(),
	inputSummary: recordsFilter.inputBounds,
};
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe("lattice reference reproduction (spec sections 27 and 45)", () => {
	it("keeps every permutation of the five predicates equivalent to the oracle", () => {
		const edge = recordBoundaryFixture() as unknown as Value;
		const expected = canonical(recordsFilter.oracle(edge));
		const orders = permutations(RECORD_BASELINE);
		expect(orders).toHaveLength(120);
		for (const order of orders) {
			const run = interpret(recordsFilterProgram(order), edge, context);
			expect(run.ok && canonical(run.value)).toBe(expected);
		}
	});

	it("finds the reference's winning order in the same 27 development evaluations", () => {
		const report = searchImprovement({
			contract: recordsFilter,
			parent: recordsFilter.seed(),
			costCases: recordsFilter.fixtures.development(),
			checkCases: recordsFilter.fixtures.regression(),
			policy: REFERENCE_POLICY,
			limits: INSTALLATION_LIMITS,
			library: new Map(),
			seed: 1,
		});
		expect(report.evaluations).toBe(27);
		expect(report.stopReason).toBe("local optimum");
		expect(programHash(report.best, PRIMITIVE_LIBRARY_HASH)).toBe(
			programHash(
				recordsFilterProgram(["is_log", "old_enough", "size_positive", "visible", "text_hit"]),
				PRIMITIVE_LIBRARY_HASH,
			),
		);
	});

	it("reproduces the published release numbers value for value (Mersenne Twister and bootstrap)", () => {
		const parent = recordsFilterProgram(RECORD_BASELINE);
		const child = recordsFilterProgram(["is_log", "old_enough", "size_positive", "visible", "text_hit"]);
		const release = recordsFilter.fixtures.release(1);
		const p = evaluateSuite(recordsFilter, parent, release, context);
		const c = evaluateSuite(recordsFilter, child, release, context);
		expect(p.allCorrect && c.allCorrect).toBe(true);
		expect(sum(p.costs)).toBe(594_668);
		expect(sum(c.costs)).toBe(59_961);
		const bound = bootstrapLowerBound(pairedGains(p.costs, c.costs));
		expect(bound.mean).toBeCloseTo(0.8993017556599967, 12);
		expect(bound.lower).toBeCloseTo(0.8918515609205374, 12);
		const shifted = recordsFilter.fixtures.shifted(1);
		const ratio =
			sum(evaluateSuite(recordsFilter, child, shifted, context).costs) /
			sum(evaluateSuite(recordsFilter, parent, shifted, context).costs);
		expect(ratio).toBeCloseTo(0.3438064992314412, 12);
	});

	it("samples like CPython's random.Random", () => {
		// random.Random(0): random() -> 0.8444218515250481, randrange(40) sequence starts deterministically.
		expect(new PyRandom(0).random()).toBeCloseTo(0.8444218515250481, 15);
		expect(new PyRandom(42).random()).toBeCloseTo(0.6394267984578837, 15);
	});
});

describe("lattice statistics and the release gate", () => {
	it("spends alpha so the sequence sums to the total", () => {
		expect(alphaForCampaign(1)).toBeCloseTo(0.01, 15);
		let total = 0;
		for (let k = 1; k <= 10_000; k++) total += alphaForCampaign(k);
		expect(total).toBeLessThan(0.02);
		expect(total).toBeGreaterThan(0.0199);
	});

	it("treats missing evidence as incomplete and every requirement as a conjunction", () => {
		expect(releaseGate({ typecheckPassed: true }).verdict).toBe("incomplete");
		const passing = {
			typecheckPassed: true,
			permissionsValid: true,
			regressionsPassed: true,
			releaseCorrect: true,
			improvementLowerBound: 0.2,
			absoluteGain: 50,
			worstProtectedRegression: -0.1,
			resourcesWithinLimits: true,
			reproducible: true,
			shadowPassed: true,
			parentStillActive: true,
		};
		expect(releaseGate(passing).verdict).toBe("pass");
		// A large gain cannot compensate for a failed hard condition.
		expect(releaseGate({ ...passing, improvementLowerBound: 0.99, regressionsPassed: false }).verdict).toBe("fail");
		expect(releaseGate({ ...passing, worstProtectedRegression: 0.01 }).reasons[0]).toMatch(/protected group/);
	});
});

describe("lattice static admission", () => {
	const seed = recordsFilter.seed();
	const bad: [string, unknown][] = [
		["unknown primitive", { ...seed, body: { node: "call", op: "system", args: [] } }],
		["unbound variable", { ...seed, body: { node: "var", name: "x" } }],
		["loop bound above policy", { ...seed, body: { ...(seed.body as object), maxItems: 1e9 } }],
		["wrong output type", { ...seed, output_type: T.string }],
		[
			"wrong argument type",
			{
				...seed,
				output_type: T.bool,
				body: { node: "call", op: "not", args: [{ node: "const", type: T.int, value: 1 }] },
			},
		],
		["missing skill", { ...seed, body: { node: "skill", hash: "a".repeat(64), args: [] } }],
		["malformed node", { ...seed, body: { node: "eval", code: "process.exit()" } }],
		[
			"undeclared read effect",
			{
				...seed,
				output_type: T.string,
				body: { node: "call", op: "read_text", args: [{ node: "const", type: T.string, value: "x" }] },
			},
		],
		[
			"const value outside its type",
			{ ...seed, output_type: T.int, body: { node: "const", type: T.int, value: 1.5 } },
		],
	];
	for (const [name, program] of bad) {
		it(`rejects: ${name}`, () => {
			expect(checkProgram(program, checkOptions).ok).toBe(false);
		});
	}

	it("rejects a 100,000-deep AST without exhausting the stack", () => {
		let body: unknown = { node: "const", type: T.bool, value: true };
		for (let i = 0; i < 100_000; i++) body = { node: "call", op: "not", args: [body] };
		const result = checkProgram({ ...seed, output_type: T.bool, body }, checkOptions);
		expect(result.ok).toBe(false);
	});

	it("allows a read effect only when the contract grants it", () => {
		const program = {
			...seed,
			output_type: T.string,
			body: { node: "call", op: "read_text", args: [{ node: "const", type: T.string, value: "a.txt" }] },
		};
		expect(checkProgram(program, { ...checkOptions, granted: new Set(["read" as const]) }).ok).toBe(true);
	});

	it("hashes alpha-equivalent programs the same", () => {
		const renamed = JSON.parse(JSON.stringify(seed).replaceAll('"r"', '"row"')) as Program;
		expect(programHash(renamed, PRIMITIVE_LIBRARY_HASH)).toBe(programHash(seed, PRIMITIVE_LIBRARY_HASH));
	});

	it("proves totality from contract bounds (and not for unbounded accumulators)", () => {
		const check = checkProgram(inventoryReport.seed(), {
			...checkOptions,
			inputSummary: inventoryReport.inputBounds,
		});
		expect(check.ok && check.total).toBe(true);
		const fold: Program = {
			ir_version: IR_VERSION,
			input_type: T.list(T.int),
			output_type: T.int,
			body: {
				node: "fold",
				list: { node: "input" },
				init: { node: "const", type: T.int, value: 0 },
				item: "x",
				acc: "a",
				body: {
					node: "call",
					op: "add",
					args: [
						{ node: "var", name: "a" },
						{ node: "var", name: "x" },
					],
				},
				maxItems: 10,
			},
		};
		const foldCheck = checkProgram(fold, { ...checkOptions, inputSummary: { card: 10, item: { mag: 5 } } });
		expect(foldCheck.ok && foldCheck.total).toBe(false);
	});
});

describe("lattice interpreter and bytecode", () => {
	const x: Expr = { node: "var", name: "x" };
	const program: Program = {
		ir_version: IR_VERSION,
		input_type: T.list(T.int),
		output_type: T.record({ total: T.int, sorted: T.list(T.int), big: T.list(T.int), sign: T.string }),
		body: {
			node: "let",
			name: "total",
			value: { node: "call", op: "sum", args: [{ node: "input" }] },
			body: {
				node: "record",
				fields: {
					total: { node: "var", name: "total" },
					sorted: {
						node: "sort",
						list: { node: "input" },
						param: "x",
						key: { node: "call", op: "sub", args: [{ node: "const", type: T.int, value: 0 }, x] },
						maxItems: 64,
					},
					big: {
						node: "filter",
						list: { node: "input" },
						param: "x",
						body: {
							node: "or",
							args: [
								{ node: "call", op: "gt", args: [x, { node: "const", type: T.int, value: 10 }] },
								{ node: "call", op: "eq", args: [x, { node: "const", type: T.int, value: 0 }] },
							],
						},
						maxItems: 64,
					},
					sign: {
						node: "if",
						cond: {
							node: "call",
							op: "ge",
							args: [
								{ node: "var", name: "total" },
								{ node: "const", type: T.int, value: 0 },
							],
						},
						ifTrue: { node: "const", type: T.string, value: "non-negative" },
						ifFalse: { node: "const", type: T.string, value: "negative" },
					},
				},
			},
		},
	};

	it("evaluates let, record, sort (stable), filter with or, and if", () => {
		const run = interpret(program, [3, 0, 42, -7, 11], context);
		expect(run.ok).toBe(true);
		if (run.ok) {
			expect(run.value).toEqual({ total: 49, sorted: [42, 11, 3, 0, -7], big: [0, 42, 11], sign: "non-negative" });
		}
	});

	it("returns typed errors for overflow, bounds and fuel", () => {
		const overflow = interpret(program, [Number.MAX_SAFE_INTEGER, 1], context);
		expect(!overflow.ok && overflow.error.code).toBe("overflow");
		const bound = interpret(
			program,
			Array.from({ length: 65 }, () => 1),
			context,
		);
		expect(!bound.ok && bound.error.code).toBe("bound");
		const fuel = interpret(program, [1, 2, 3], { ...context, limits: { ...INSTALLATION_LIMITS, maxFuel: 2 } });
		expect(!fuel.ok && fuel.error.code).toBe("fuel");
	});

	it("stops at a deadline", () => {
		const big = recordsFilter.fixtures.development()[0];
		const run = interpret(recordsFilter.seed(), big, { ...context, deadline: performance.now() - 1 });
		expect(!run.ok && run.error.code).toBe("deadline");
	});

	it("compiles to verified bytecode that agrees with the interpreter, including errors and fuel", () => {
		const inputs: Value[] = [
			[],
			[1],
			[3, 0, 42, -7, 11],
			[Number.MAX_SAFE_INTEGER, 1],
			Array.from({ length: 65 }, () => 1),
		];
		const bytecode = compileProgram(program, new Map());
		verifyBytecode(bytecode, INSTALLATION_LIMITS);
		expect(differential(program, bytecode, inputs, context).mismatches).toEqual([]);
		for (const order of permutations(RECORD_BASELINE).slice(0, 12)) {
			const records = recordsFilterProgram(order);
			const compiled = compileProgram(records, new Map());
			const report = differential(
				records,
				compiled,
				[recordBoundaryFixture() as unknown as Value, ...recordsFilter.fixtures.development().slice(0, 2)],
				context,
			);
			expect(report.mismatches).toEqual([]);
		}
		const inventory = inventoryReport.seed();
		const report = differential(
			inventory,
			compileProgram(inventory, new Map()),
			inventoryReport.fixtures.regression(),
			context,
		);
		expect(report.mismatches).toEqual([]);
	});

	it("rejects bytecode whose operands do not index a table", () => {
		const bytecode = compileProgram(program, new Map());
		bytecode.chunks[0].unshift(["LOAD_CONST", 999]);
		expect(() => verifyBytecode(bytecode, INSTALLATION_LIMITS)).toThrow(/invalid instruction/);
		const fuelLimited = runBytecode(compileProgram(program, new Map()), [1, 2], {
			...context,
			limits: { ...INSTALLATION_LIMITS, maxFuel: 1 },
		});
		expect(!fuelLimited.ok && fuelLimited.error.code).toBe("fuel");
	});
});
