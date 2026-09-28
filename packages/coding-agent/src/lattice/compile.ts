import { canonical, digest } from "./canonical.ts";
import {
	checkOutputSize,
	interpret,
	type RunMetrics,
	type RunOptions,
	type RunResult,
	sortCost,
	stableSortByKeys,
} from "./interpreter.ts";
import type { Expr, LibrarySkill, Program, Value } from "./ir.ts";
import type { ExecutionLimits } from "./limits.ts";
import { type Host, LatticeError, PRIMITIVES } from "./primitives.ts";

/**
 * Compact bytecode for the bounded IR (spec section 42.6). Operands are indexes into validated
 * tables, never addresses. Fuel is charged exactly as the interpreter charges it, so a compiled
 * skill is accepted only when differential tests (section 21.3) find identical outputs, error
 * classes and virtual costs.
 */
export const COMPILER_VERSION = 1;

export type Instr =
	| ["LOAD_INPUT"]
	| ["LOAD_CONST", number]
	| ["LOAD_VAR", number]
	| ["STORE_VAR", number]
	| ["CALL_PRIMITIVE", number, number]
	| ["FIELD", number]
	| ["MAKE_RECORD", number]
	| ["BRANCH_IF_FALSE", number]
	| ["JUMP", number]
	| ["AND_JUMP", number]
	| ["OR_JUMP", number]
	| ["MAP_BOUNDED", number, number, number]
	| ["FILTER_BOUNDED", number, number, number]
	| ["SORT_BOUNDED", number, number, number]
	| ["FOLD_BOUNDED", number, number, number, number]
	| ["CALL_PINNED_SKILL", number, number, number]
	| ["RETURN"];

export interface Bytecode {
	compiler_version: number;
	chunks: Instr[][];
	consts: Value[];
	names: string[];
	keys: string[][];
	prims: string[];
	slots: number;
}

export function compileProgram(program: Program, library: ReadonlyMap<string, LibrarySkill>): Bytecode {
	const chunks: Instr[][] = [[]];
	const consts: Value[] = [];
	const names: string[] = [];
	const keys: string[][] = [];
	const prims: string[] = [];
	const skillChunks = new Map<string, { chunk: number; firstSlot: number; arity: number }>();
	let slots = 0;
	const intern = <V>(table: V[], value: V) => {
		const key = canonical(value);
		const found = table.findIndex((entry) => canonical(entry) === key);
		if (found >= 0) return found;
		table.push(value);
		return table.length - 1;
	};

	const emit = (expr: Expr, scope: ReadonlyMap<string, number>, code: Instr[]): void => {
		switch (expr.node) {
			case "input":
				code.push(["LOAD_INPUT"]);
				return;
			case "const":
				code.push(["LOAD_CONST", intern(consts, expr.value)]);
				return;
			case "var": {
				const slot = scope.get(expr.name);
				if (slot === undefined) throw new Error(`unbound variable ${expr.name}`);
				code.push(["LOAD_VAR", slot]);
				return;
			}
			case "let": {
				emit(expr.value, scope, code);
				const slot = slots++;
				code.push(["STORE_VAR", slot]);
				emit(expr.body, new Map([...scope, [expr.name, slot]]), code);
				return;
			}
			case "if": {
				emit(expr.cond, scope, code);
				const branch: Instr = ["BRANCH_IF_FALSE", -1];
				code.push(branch);
				emit(expr.ifTrue, scope, code);
				const jump: Instr = ["JUMP", -1];
				code.push(jump);
				branch[1] = code.length;
				emit(expr.ifFalse, scope, code);
				jump[1] = code.length;
				return;
			}
			case "and":
			case "or": {
				const exits: Instr[] = [];
				expr.args.forEach((arg, index) => {
					emit(arg, scope, code);
					if (index < expr.args.length - 1) {
						const exit: Instr = [expr.node === "and" ? "AND_JUMP" : "OR_JUMP", -1];
						code.push(exit);
						exits.push(exit);
					}
				});
				for (const exit of exits) exit[1] = code.length;
				return;
			}
			case "call":
				for (const arg of expr.args) emit(arg, scope, code);
				code.push(["CALL_PRIMITIVE", intern(prims, expr.op), expr.args.length]);
				return;
			case "field":
				emit(expr.record, scope, code);
				code.push(["FIELD", intern(names, expr.name)]);
				return;
			case "record": {
				const fieldKeys = Object.keys(expr.fields).sort();
				for (const key of fieldKeys) emit(expr.fields[key], scope, code);
				code.push(["MAKE_RECORD", intern(keys, fieldKeys)]);
				return;
			}
			case "map":
			case "filter":
			case "sort": {
				emit(expr.list, scope, code);
				const slot = slots++;
				const chunk = chunks.length;
				const body: Instr[] = [];
				chunks.push(body);
				emit(expr.node === "sort" ? expr.key : expr.body, new Map([...scope, [expr.param, slot]]), body);
				body.push(["RETURN"]);
				const op = expr.node === "map" ? "MAP_BOUNDED" : expr.node === "filter" ? "FILTER_BOUNDED" : "SORT_BOUNDED";
				code.push([op, chunk, slot, expr.maxItems]);
				return;
			}
			case "fold": {
				emit(expr.list, scope, code);
				emit(expr.init, scope, code);
				const itemSlot = slots++;
				const accSlot = slots++;
				const chunk = chunks.length;
				const body: Instr[] = [];
				chunks.push(body);
				emit(expr.body, new Map([...scope, [expr.item, itemSlot], [expr.acc, accSlot]]), body);
				body.push(["RETURN"]);
				code.push(["FOLD_BOUNDED", chunk, itemSlot, accSlot, expr.maxItems]);
				return;
			}
			case "skill": {
				for (const arg of expr.args) emit(arg, scope, code);
				let compiled = skillChunks.get(expr.hash);
				if (!compiled) {
					const skill = library.get(expr.hash);
					if (!skill) throw new Error("missing skill");
					const firstSlot = slots;
					slots += skill.params.length;
					const chunk = chunks.length;
					const body: Instr[] = [];
					chunks.push(body);
					compiled = { chunk, firstSlot, arity: skill.params.length };
					skillChunks.set(expr.hash, compiled);
					emit(skill.body, new Map(skill.params.map((param, index) => [param.name, firstSlot + index])), body);
					body.push(["RETURN"]);
				}
				code.push(["CALL_PINNED_SKILL", compiled.chunk, compiled.arity, compiled.firstSlot]);
				return;
			}
		}
	};
	emit(program.body, new Map(), chunks[0]);
	chunks[0].push(["RETURN"]);
	return { compiler_version: COMPILER_VERSION, chunks, consts, names, keys, prims, slots };
}

export function bytecodeHash(bytecode: Bytecode): string {
	return digest(bytecode);
}

/** Reject any operand that does not index a table entry, chunk or slot. Run on every load. */
export function verifyBytecode(bytecode: Bytecode, limits: ExecutionLimits): void {
	if (bytecode.compiler_version !== COMPILER_VERSION) throw new Error("incompatible compiler version");
	const inRange = (value: number, size: number) => Number.isInteger(value) && value >= 0 && value < size;
	for (const prim of bytecode.prims) if (!PRIMITIVES.has(prim)) throw new Error(`unknown primitive ${prim}`);
	bytecode.chunks.forEach((chunk, chunkIndex) => {
		if (chunk.length === 0 || chunk[chunk.length - 1][0] !== "RETURN") throw new Error("chunk must end in RETURN");
		for (const instr of chunk) {
			const [op, a, b, c, d] = instr as [string, number, number, number, number];
			const ok = (() => {
				switch (op) {
					case "LOAD_INPUT":
					case "RETURN":
						return true;
					case "LOAD_CONST":
						return inRange(a, bytecode.consts.length);
					case "LOAD_VAR":
					case "STORE_VAR":
						return inRange(a, bytecode.slots);
					case "CALL_PRIMITIVE":
						return inRange(a, bytecode.prims.length) && inRange(b, 17);
					case "FIELD":
						return inRange(a, bytecode.names.length);
					case "MAKE_RECORD":
						return inRange(a, bytecode.keys.length);
					case "BRANCH_IF_FALSE":
					case "JUMP":
					case "AND_JUMP":
					case "OR_JUMP":
						return Number.isInteger(a) && a > 0 && a <= chunk.length;
					case "MAP_BOUNDED":
					case "FILTER_BOUNDED":
					case "SORT_BOUNDED":
						return (
							inRange(a, bytecode.chunks.length) &&
							a !== chunkIndex &&
							inRange(b, bytecode.slots) &&
							inRange(c, limits.maxItems + 1)
						);
					case "FOLD_BOUNDED":
						return (
							inRange(a, bytecode.chunks.length) &&
							a !== chunkIndex &&
							inRange(b, bytecode.slots) &&
							inRange(c, bytecode.slots) &&
							inRange(d, limits.maxItems + 1)
						);
					case "CALL_PINNED_SKILL":
						return inRange(a, bytecode.chunks.length) && a !== chunkIndex && inRange(c + b, bytecode.slots + 1);
					default:
						return false;
				}
			})();
			if (!ok) throw new Error(`invalid instruction ${JSON.stringify(instr)}`);
		}
	});
}

interface LoopState {
	op: "MAP_BOUNDED" | "FILTER_BOUNDED" | "SORT_BOUNDED" | "FOLD_BOUNDED";
	slot: number;
	accSlot: number;
	items: Value[];
	index: number;
	out: Value[];
}

interface Frame {
	chunk: number;
	pc: number;
	loop?: LoopState;
	depth: number;
}

export function runBytecode(bytecode: Bytecode, input: Value, options: RunOptions): RunResult {
	const metrics: RunMetrics = { units: 0, steps: 0, primitiveCalls: 0 };
	const { limits } = options;
	const host = options.host ?? {};
	const stack: Value[] = [];
	const slots: Value[] = new Array(bytecode.slots);
	const frames: Frame[] = [{ chunk: 0, pc: 0, depth: 0 }];
	const charge = (units: number) => {
		metrics.units += units;
		if (metrics.units > limits.maxFuel) throw new LatticeError("fuel", "virtual fuel exhausted");
	};
	try {
		while (frames.length > 0) {
			const frame = frames[frames.length - 1];
			const instr = bytecode.chunks[frame.chunk][frame.pc++];
			metrics.steps++;
			if (metrics.steps > limits.maxSteps * 4) throw new LatticeError("steps", "step limit exceeded");
			if ((metrics.steps & 1023) === 0) {
				if (options.signal?.aborted) throw new LatticeError("deadline", "cancelled");
				if (options.deadline !== undefined && performance.now() > options.deadline) {
					throw new LatticeError("deadline", "deadline exceeded");
				}
			}
			switch (instr[0]) {
				case "LOAD_INPUT":
					stack.push(input);
					break;
				case "LOAD_CONST":
					stack.push(bytecode.consts[instr[1]]);
					break;
				case "LOAD_VAR":
					stack.push(slots[instr[1]]);
					break;
				case "STORE_VAR":
					slots[instr[1]] = stack.pop()!;
					break;
				case "CALL_PRIMITIVE": {
					const primitive = PRIMITIVES.get(bytecode.prims[instr[1]])!;
					const args = stack.splice(stack.length - instr[2]);
					charge(primitive.cost(args));
					metrics.primitiveCalls++;
					const result = primitive.impl(args, host);
					if (typeof result === "string" && Buffer.byteLength(result, "utf8") > limits.maxStringBytes) {
						throw new LatticeError("bound", "string exceeds policy");
					}
					stack.push(result);
					break;
				}
				case "FIELD":
					stack.push((stack.pop() as { [name: string]: Value })[bytecode.names[instr[1]]]);
					break;
				case "MAKE_RECORD": {
					const fieldKeys = bytecode.keys[instr[1]];
					const parts = stack.splice(stack.length - fieldKeys.length);
					const record: { [name: string]: Value } = {};
					fieldKeys.forEach((key, index) => {
						record[key] = parts[index];
					});
					stack.push(record);
					break;
				}
				case "BRANCH_IF_FALSE":
					if (!stack.pop()) frame.pc = instr[1];
					break;
				case "JUMP":
					frame.pc = instr[1];
					break;
				case "AND_JUMP":
					if (!stack[stack.length - 1]) frame.pc = instr[1];
					else stack.pop();
					break;
				case "OR_JUMP":
					if (stack[stack.length - 1]) frame.pc = instr[1];
					else stack.pop();
					break;
				case "MAP_BOUNDED":
				case "FILTER_BOUNDED":
				case "SORT_BOUNDED": {
					const items = stack.pop() as Value[];
					const node = instr[0] === "MAP_BOUNDED" ? "map" : instr[0] === "FILTER_BOUNDED" ? "filter" : "sort";
					if (items.length > instr[3]) throw new LatticeError("bound", `${node} input exceeds maxItems`);
					if (items.length === 0) {
						stack.push([]);
						break;
					}
					slots[instr[2]] = items[0];
					frames.push({
						chunk: instr[1],
						pc: 0,
						depth: frame.depth,
						loop: { op: instr[0], slot: instr[2], accSlot: -1, items, index: 0, out: [] },
					});
					break;
				}
				case "FOLD_BOUNDED": {
					const init = stack.pop()!;
					const items = stack.pop() as Value[];
					if (items.length > instr[4]) throw new LatticeError("bound", "fold input exceeds maxItems");
					if (items.length === 0) {
						stack.push(init);
						break;
					}
					slots[instr[2]] = items[0];
					slots[instr[3]] = init;
					frames.push({
						chunk: instr[1],
						pc: 0,
						depth: frame.depth,
						loop: { op: "FOLD_BOUNDED", slot: instr[2], accSlot: instr[3], items, index: 0, out: [] },
					});
					break;
				}
				case "CALL_PINNED_SKILL": {
					if (frame.depth + 1 > limits.maxSkillCallDepth)
						throw new LatticeError("bound", "skill call depth exceeded");
					const args = stack.splice(stack.length - instr[2]);
					args.forEach((arg, index) => {
						slots[instr[3] + index] = arg;
					});
					frames.push({ chunk: instr[1], pc: 0, depth: frame.depth + 1 });
					break;
				}
				case "RETURN": {
					const loop = frame.loop;
					if (!loop) {
						frames.pop();
						break;
					}
					const result = stack.pop()!;
					if (loop.op === "MAP_BOUNDED" || loop.op === "SORT_BOUNDED") loop.out.push(result);
					else if (loop.op === "FILTER_BOUNDED") {
						if (result) loop.out.push(loop.items[loop.index]);
					}
					const next = loop.index + 1;
					if (next < loop.items.length) {
						loop.index = next;
						slots[loop.slot] = loop.items[next];
						if (loop.op === "FOLD_BOUNDED") slots[loop.accSlot] = result;
						frame.pc = 0;
						break;
					}
					frames.pop();
					if (loop.op === "FOLD_BOUNDED") stack.push(result);
					else if (loop.op === "SORT_BOUNDED") {
						charge(sortCost(loop.items.length));
						stack.push(stableSortByKeys(loop.items, loop.out));
					} else stack.push(loop.out);
					break;
				}
			}
		}
		const value = stack.pop()!;
		checkOutputSize(value, limits);
		return { ok: true, value, metrics };
	} catch (error) {
		if (error instanceof LatticeError)
			return { ok: false, error: { code: error.code, message: error.message }, metrics };
		throw error;
	}
}

export interface DifferentialReport {
	cases: number;
	mismatches: { index: number; reason: string }[];
}

/**
 * Differential test (spec section 21.3): run interpreted and compiled forms on every input and
 * compare outputs, error classes, virtual cost and primitive calls. Steps differ by design
 * (nodes versus instructions) and are the one allowed difference. `hostFor` gives each input its
 * world (for `read` effects); both forms see the same host.
 */
export function differential(
	program: Program,
	bytecode: Bytecode,
	inputs: readonly Value[],
	options: Omit<RunOptions, "host"> & { hostFor?: (input: Value) => Host },
): DifferentialReport {
	const { hostFor, ...rest } = options;
	const mismatches: { index: number; reason: string }[] = [];
	inputs.forEach((input, index) => {
		const run = { ...rest, host: hostFor?.(input) };
		const a = interpret(program, input, run);
		const b = runBytecode(bytecode, input, run);
		if (a.ok !== b.ok) mismatches.push({ index, reason: "one form failed and the other did not" });
		else if (a.ok && b.ok && canonical(a.value) !== canonical(b.value))
			mismatches.push({ index, reason: "outputs differ" });
		else if (!a.ok && !b.ok && a.error.code !== b.error.code)
			mismatches.push({ index, reason: "error classes differ" });
		else if (a.metrics.units !== b.metrics.units || a.metrics.primitiveCalls !== b.metrics.primitiveCalls) {
			mismatches.push({ index, reason: "fuel accounting differs" });
		}
	});
	return { cases: inputs.length, mismatches };
}
