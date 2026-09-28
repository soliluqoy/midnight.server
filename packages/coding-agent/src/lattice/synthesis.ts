import { canonical } from "./canonical.ts";
import { interpret } from "./interpreter.ts";
import { type Expr, IR_VERSION, type LibrarySkill, type Program, T, type Type, typeEquals, type Value } from "./ir.ts";
import type { ExecutionLimits } from "./limits.ts";

/**
 * Typed bottom-up enumeration (spec section 40.2) for tasks defined by examples: find a filter
 * predicate P such that `map(filter(input, r => P), r => r.id)` reproduces every example.
 *
 * Expressions are built by size from atoms (field tests against constants harvested from the
 * examples, plus library abstractions instantiated with those constants, each one component)
 * and combined with not/and/or. Two expressions with the same truth vector on the development
 * rows behave the same there, so only the first is kept (observational equivalence: a pruning
 * heuristic, not proof). Held-out examples are checked afterwards; a failing one becomes a
 * development example and the search repeats (counterexample-guided, section 10.6).
 */
export interface ExampleTask {
	name: string;
	recordType: Type;
	idField: string;
	examples: { input: Value; output: Value }[];
}

export interface SynthesisOptions {
	limits: ExecutionLimits;
	library: ReadonlyMap<string, LibrarySkill>;
	/** Budget: expressions enumerated across all rounds. */
	maxCandidates: number;
	maxSize: number;
	maxRounds?: number;
}

export interface SynthesisResult {
	found: boolean;
	program?: Program;
	predicate?: Expr;
	/** Components in the predicate (an abstraction call counts as one). */
	size?: number;
	enumerated: number;
	rounds: number;
	/** Examples never used for generation that the program reproduces. */
	heldout: { passed: number; total: number };
	counterexamples: number;
	stopReason: string;
}

interface Candidate {
	expr: Expr;
	size: number;
	bits: bigint;
}

type Row = { [field: string]: Value };

const MAX_INT_CONSTANTS = 48;

export function taskProgram(task: ExampleTask, predicate: Expr): Program {
	return {
		ir_version: IR_VERSION,
		input_type: T.list(task.recordType),
		output_type: T.list(fieldType(task, task.idField)),
		body: {
			node: "map",
			list: { node: "filter", list: { node: "input" }, param: "r", body: predicate, maxItems: 4096 },
			param: "r",
			body: { node: "field", record: { node: "var", name: "r" }, name: task.idField },
			maxItems: 4096,
		},
	};
}

function fieldType(task: ExampleTask, field: string): Type {
	if (task.recordType.kind !== "record" || !task.recordType.fields[field])
		throw new Error(`task has no field ${field}`);
	return task.recordType.fields[field];
}

function harvest(
	task: ExampleTask,
	rows: readonly Row[],
): { ints: Map<string, number[]>; strings: Map<string, string[]>; tokens: string[] } {
	const ints = new Map<string, number[]>();
	const strings = new Map<string, string[]>();
	const tokenCounts = new Map<string, number>();
	if (task.recordType.kind !== "record") throw new Error("task records must be records");
	for (const [field, type] of Object.entries(task.recordType.fields)) {
		if (field === task.idField) continue;
		const counts = new Map<string, number>();
		for (const row of rows) counts.set(canonical(row[field]), (counts.get(canonical(row[field])) ?? 0) + 1);
		const frequent = [...counts.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.map(([key]) => JSON.parse(key) as Value);
		if (type.kind === "int") {
			// Every distinct value while there are few; otherwise an evenly spaced sample (thresholds
			// need values from the whole range, not the smallest or most frequent ones).
			const distinct = [...new Set([0, ...(frequent as number[])])].sort((a, b) => a - b);
			const step = distinct.length / MAX_INT_CONSTANTS;
			ints.set(
				field,
				distinct.length <= MAX_INT_CONSTANTS
					? distinct
					: Array.from({ length: MAX_INT_CONSTANTS }, (_, i) => distinct[Math.floor(i * step)]),
			);
		}
		if (type.kind === "string") {
			strings.set(field, (frequent as string[]).slice(0, 12));
			for (const row of rows) {
				for (const token of String(row[field]).match(/[A-Z]{3,}/g) ?? [])
					tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
			}
		}
	}
	const tokens = [...tokenCounts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([token]) => token)
		.slice(0, 6);
	return { ints, strings, tokens };
}

const r: Expr = { node: "var", name: "r" };
const field = (name: string): Expr => ({ node: "field", record: r, name });
const call = (op: string, ...args: Expr[]): Expr => ({ node: "call", op, args });

function atoms(task: ExampleTask, rows: readonly Row[], library: ReadonlyMap<string, LibrarySkill>): Expr[] {
	const { ints, strings, tokens } = harvest(task, rows);
	const out: Expr[] = [];
	if (task.recordType.kind !== "record") return out;
	for (const [name, type] of Object.entries(task.recordType.fields)) {
		if (name === task.idField) continue;
		if (type.kind === "bool") out.push(field(name));
		if (type.kind === "int") {
			for (const value of ints.get(name) ?? []) {
				const constant: Expr = { node: "const", type: T.int, value };
				for (const op of ["gt", "ge", "eq"]) out.push(call(op, field(name), constant));
			}
		}
		if (type.kind === "string") {
			for (const value of strings.get(name) ?? [])
				out.push(call("eq", field(name), { node: "const", type: T.string, value }));
			for (const token of tokens)
				out.push(call("contains", field(name), { node: "const", type: T.string, value: token }));
		}
	}
	// Library abstractions whose first parameter takes the record and whose others take constants.
	for (const [hash, skill] of library) {
		const [first, ...rest] = skill.params;
		if (!first || !typeEquals(first.type, task.recordType) || rest.length > 3) continue;
		const pools = rest.map((param) => constantsFor(param.type, ints, strings, tokens));
		if (pools.some((pool) => pool.length === 0)) continue;
		const combos = pools.reduce<Expr[][]>(
			(acc, pool) => acc.flatMap((prefix) => pool.map((value) => [...prefix, value])),
			[[]],
		);
		for (const args of combos.slice(0, 2000)) out.push({ node: "skill", hash, args: [r, ...args] });
	}
	return out;
}

function constantsFor(
	type: Type,
	ints: Map<string, number[]>,
	strings: Map<string, string[]>,
	tokens: string[],
): Expr[] {
	if (type.kind === "int") {
		return [...new Set([...ints.values()].flat())]
			.sort((a, b) => a - b)
			.map((value) => ({ node: "const", type: T.int, value }));
	}
	if (type.kind === "string") {
		return [...new Set([...[...strings.values()].flat(), ...tokens])].map((value) => ({
			node: "const",
			type: T.string,
			value,
		}));
	}
	if (type.kind === "bool") return [true, false].map((value) => ({ node: "const", type: T.bool, value }));
	return [];
}

function flatten(kind: "and" | "or", a: Expr, b: Expr): Expr {
	const parts = (expr: Expr) => (expr.node === kind ? expr.args : [expr]);
	return { node: kind, args: [...parts(a), ...parts(b)] };
}

/** Truth vector of `predicate` over `rows` (evaluated in policy-sized chunks), or undefined if it fails. */
function truth(
	task: ExampleTask,
	predicate: Expr,
	rows: readonly Row[],
	limits: ExecutionLimits,
	library: ReadonlyMap<string, LibrarySkill>,
): bigint | undefined {
	const program: Program = {
		ir_version: IR_VERSION,
		input_type: T.list(task.recordType),
		output_type: T.list(T.bool),
		body: { node: "map", list: { node: "input" }, param: "r", body: predicate, maxItems: limits.maxItems },
	};
	let bits = 0n;
	for (let start = 0; start < rows.length; start += limits.maxItems) {
		const run = interpret(program, rows.slice(start, start + limits.maxItems) as Value, { limits, library });
		if (!run.ok) return undefined;
		(run.value as boolean[]).forEach((value, index) => {
			if (value) bits |= 1n << BigInt(start + index);
		});
	}
	return bits;
}

function reproduces(program: Program, example: { input: Value; output: Value }, options: SynthesisOptions): boolean {
	const run = interpret(program, example.input, { limits: options.limits, library: options.library });
	return run.ok && canonical(run.value) === canonical(example.output);
}

export function synthesize(task: ExampleTask, options: SynthesisOptions): SynthesisResult {
	const maxRounds = options.maxRounds ?? 4;
	// Split by source example: even indexes generate, odd ones are held out.
	const development = task.examples.filter((_, index) => index % 2 === 0);
	const heldout = task.examples.filter((_, index) => index % 2 === 1);
	let enumerated = 0;
	let counterexamples = 0;
	for (let round = 1; round <= maxRounds; round++) {
		const rows: Row[] = [];
		let target = 0n;
		for (const example of development) {
			const ids = new Set((example.output as Value[]).map((id) => canonical(id)));
			for (const row of example.input as Row[]) {
				if (ids.has(canonical(row[task.idField]))) target |= 1n << BigInt(rows.length);
				rows.push(row);
			}
		}
		const full = (1n << BigInt(rows.length)) - 1n;
		const bySize: Candidate[][] = [[]];
		const seen = new Set<bigint>();
		let found: Candidate | undefined;
		const add = (expr: Expr, size: number, bits: bigint | undefined): boolean => {
			enumerated++;
			if (bits === undefined || seen.has(bits)) return false;
			seen.add(bits);
			const candidate = { expr, size, bits };
			bySize[size].push(candidate);
			if (bits === target) found = candidate;
			return found !== undefined;
		};
		const budgetLeft = () => enumerated < options.maxCandidates;
		bySize[1] = [];
		for (const atom of atoms(task, rows, options.library)) {
			if (!budgetLeft() || add(atom, 1, truth(task, atom, rows, options.limits, options.library))) break;
		}
		for (let size = 2; size <= options.maxSize && !found && budgetLeft(); size++) {
			bySize[size] = [];
			for (const x of bySize[size - 1] ?? []) {
				if (found || !budgetLeft()) break;
				if (x.expr.node !== "call" || x.expr.op !== "not")
					add({ node: "call", op: "not", args: [x.expr] }, size, full & ~x.bits);
			}
			for (let left = 1; left <= size - 2 && !found && budgetLeft(); left++) {
				const right = size - 1 - left;
				if (left > right) break;
				const xs = bySize[left] ?? [];
				const ys = bySize[right] ?? [];
				for (let i = 0; i < xs.length && !found && budgetLeft(); i++) {
					for (let j = left === right ? i + 1 : 0; j < ys.length && !found && budgetLeft(); j++) {
						const a = xs[i];
						const b = ys[j];
						if (add(flatten("and", a.expr, b.expr), size, a.bits & b.bits)) break;
						if (add(flatten("or", a.expr, b.expr), size, a.bits | b.bits)) break;
					}
				}
			}
		}
		if (!found) {
			return {
				found: false,
				enumerated,
				rounds: round,
				heldout: { passed: 0, total: heldout.length },
				counterexamples,
				stopReason: budgetLeft() ? "size limit reached" : "candidate budget exhausted",
			};
		}
		const program = taskProgram(task, found.expr);
		const failing = heldout.findIndex((example) => !reproduces(program, example, options));
		if (failing < 0) {
			return {
				found: true,
				program,
				predicate: found.expr,
				size: found.size,
				enumerated,
				rounds: round,
				heldout: { passed: heldout.length, total: heldout.length },
				counterexamples,
				stopReason: "solved",
			};
		}
		// Counterexample: it becomes development evidence and is no longer counted as held out.
		development.push(heldout.splice(failing, 1)[0]);
		counterexamples++;
	}
	return {
		found: false,
		enumerated,
		rounds: maxRounds,
		heldout: { passed: 0, total: heldout.length },
		counterexamples,
		stopReason: "counterexample rounds exhausted",
	};
}
