import { canonical } from "./canonical.ts";
import type { Expr, LibrarySkill, Program, Value } from "./ir.ts";
import type { ExecutionLimits } from "./limits.ts";
import { type Host, LatticeError, PRIMITIVES } from "./primitives.ts";

/**
 * Bounded interpreter (spec section 39.7). It uses an explicit work stack instead of host
 * recursion, debits virtual fuel before every primitive runs (section 39.5), bounds steps,
 * iteration counts, skill call depth and output size, and stops on the first typed error.
 * Measurements come from this kernel code, never from the candidate: a program is data.
 */
export interface RunOptions {
	limits: ExecutionLimits;
	library: ReadonlyMap<string, LibrarySkill>;
	host?: Host;
	signal?: AbortSignal;
	/** `performance.now()` value after which execution stops with a deadline error. */
	deadline?: number;
	/** When set, receives virtual units per primitive (and `sort`) for profiling. */
	profile?: Map<string, number>;
}

export interface RunMetrics {
	/** Virtual cost: the sum of declared primitive and sort charges. */
	units: number;
	steps: number;
	primitiveCalls: number;
}

export type RunResult =
	| { ok: true; value: Value; metrics: RunMetrics }
	| { ok: false; error: { code: LatticeError["code"]; message: string }; metrics: RunMetrics };

interface Env {
	name: string;
	value: Value;
	next: Env | undefined;
}

type LoopExpr = Extract<Expr, { node: "map" | "filter" | "sort" }>;
type FoldExpr = Extract<Expr, { node: "fold" }>;

type Work =
	| { k: "eval"; expr: Expr; env: Env | undefined }
	| { k: "let"; expr: Extract<Expr, { node: "let" }>; env: Env | undefined }
	| { k: "if"; expr: Extract<Expr, { node: "if" }>; env: Env | undefined }
	| { k: "logic"; expr: Extract<Expr, { node: "and" | "or" }>; env: Env | undefined; index: number }
	| { k: "call"; expr: Extract<Expr, { node: "call" }> }
	| { k: "field"; name: string }
	| { k: "record"; keys: string[] }
	| { k: "iter"; expr: LoopExpr; env: Env | undefined }
	| { k: "loop"; expr: LoopExpr; env: Env | undefined; items: Value[]; index: number; out: Value[] }
	| { k: "fold_list"; expr: FoldExpr; env: Env | undefined }
	| { k: "fold_init"; expr: FoldExpr; env: Env | undefined; items: Value[] }
	| { k: "fold"; expr: FoldExpr; env: Env | undefined; items: Value[]; index: number }
	| { k: "skill_call"; expr: Extract<Expr, { node: "skill" }> }
	| { k: "skill_return" };

function lookup(env: Env | undefined, name: string): Value {
	for (let cursor = env; cursor; cursor = cursor.next) if (cursor.name === name) return cursor.value;
	throw new LatticeError("type", `unbound variable ${name}`);
}

function bind(env: Env | undefined, name: string, value: Value): Env {
	return { name, value, next: env };
}

/** Declared cost of a stable sort: comparison_cost * n * ceil(log2(max(n, 2))). */
export function sortCost(n: number): number {
	return 1 + n * Math.ceil(Math.log2(Math.max(n, 2)));
}

export function compareKeys(a: Value, b: Value): number {
	if (typeof a === "number" && typeof b === "number") return a - b;
	const x = String(a);
	const y = String(b);
	return x < y ? -1 : x > y ? 1 : 0;
}

export function stableSortByKeys(items: readonly Value[], keys: readonly Value[]): Value[] {
	return items
		.map((item, index) => ({ item, key: keys[index], index }))
		.sort((a, b) => compareKeys(a.key, b.key) || a.index - b.index)
		.map((entry) => entry.item);
}

export function checkOutputSize(value: Value, limits: ExecutionLimits): void {
	if (Buffer.byteLength(canonical(value), "utf8") > limits.maxOutputBytes) {
		throw new LatticeError("bound", `output exceeds ${limits.maxOutputBytes} bytes`);
	}
}

export function interpret(program: Program, input: Value, options: RunOptions): RunResult {
	const metrics: RunMetrics = { units: 0, steps: 0, primitiveCalls: 0 };
	const { limits } = options;
	const host = options.host ?? {};
	const work: Work[] = [{ k: "eval", expr: program.body, env: undefined }];
	const values: Value[] = [];
	let callDepth = 0;

	const charge = (units: number) => {
		metrics.units += units;
		if (metrics.units > limits.maxFuel) throw new LatticeError("fuel", "virtual fuel exhausted");
	};
	const startLoop = (expr: LoopExpr, env: Env | undefined, list: Value) => {
		const items = list as Value[];
		if (items.length > expr.maxItems) throw new LatticeError("bound", `${expr.node} input exceeds maxItems`);
		if (items.length === 0) {
			values.push([]);
			return;
		}
		work.push({ k: "loop", expr, env, items, index: 0, out: [] });
		work.push({ k: "eval", expr: expr.node === "sort" ? expr.key : expr.body, env: bind(env, expr.param, items[0]) });
	};

	try {
		while (work.length > 0) {
			const item = work.pop()!;
			switch (item.k) {
				case "eval": {
					metrics.steps++;
					if (metrics.steps > limits.maxSteps) throw new LatticeError("steps", "step limit exceeded");
					if ((metrics.steps & 1023) === 0) {
						if (options.signal?.aborted) throw new LatticeError("deadline", "cancelled");
						if (options.deadline !== undefined && performance.now() > options.deadline) {
							throw new LatticeError("deadline", "deadline exceeded");
						}
					}
					const { expr, env } = item;
					switch (expr.node) {
						case "input":
							values.push(input);
							break;
						case "const":
							values.push(expr.value);
							break;
						case "var":
							values.push(lookup(env, expr.name));
							break;
						case "let":
							work.push({ k: "let", expr, env }, { k: "eval", expr: expr.value, env });
							break;
						case "if":
							work.push({ k: "if", expr, env }, { k: "eval", expr: expr.cond, env });
							break;
						case "and":
						case "or":
							work.push({ k: "logic", expr, env, index: 0 }, { k: "eval", expr: expr.args[0], env });
							break;
						case "call":
							work.push({ k: "call", expr });
							for (let i = expr.args.length - 1; i >= 0; i--) work.push({ k: "eval", expr: expr.args[i], env });
							break;
						case "field":
							work.push({ k: "field", name: expr.name }, { k: "eval", expr: expr.record, env });
							break;
						case "record": {
							const keys = Object.keys(expr.fields).sort();
							work.push({ k: "record", keys });
							for (let i = keys.length - 1; i >= 0; i--)
								work.push({ k: "eval", expr: expr.fields[keys[i]], env });
							break;
						}
						case "map":
						case "filter":
						case "sort":
							work.push({ k: "iter", expr, env }, { k: "eval", expr: expr.list, env });
							break;
						case "fold":
							work.push({ k: "fold_list", expr, env }, { k: "eval", expr: expr.list, env });
							break;
						case "skill":
							work.push({ k: "skill_call", expr });
							for (let i = expr.args.length - 1; i >= 0; i--) work.push({ k: "eval", expr: expr.args[i], env });
							break;
					}
					break;
				}
				case "let":
					work.push({ k: "eval", expr: item.expr.body, env: bind(item.env, item.expr.name, values.pop()!) });
					break;
				case "if":
					work.push({ k: "eval", expr: values.pop() ? item.expr.ifTrue : item.expr.ifFalse, env: item.env });
					break;
				case "logic": {
					const value = values.pop() as boolean;
					const decided = item.expr.node === "and" ? !value : value;
					if (decided || item.index + 1 >= item.expr.args.length) values.push(value);
					else {
						work.push(
							{ ...item, index: item.index + 1 },
							{ k: "eval", expr: item.expr.args[item.index + 1], env: item.env },
						);
					}
					break;
				}
				case "call": {
					const primitive = PRIMITIVES.get(item.expr.op);
					if (!primitive) throw new LatticeError("type", `unknown primitive ${item.expr.op}`);
					const args = values.splice(values.length - item.expr.args.length);
					const cost = primitive.cost(args);
					charge(cost);
					options.profile?.set(item.expr.op, (options.profile.get(item.expr.op) ?? 0) + cost);
					metrics.primitiveCalls++;
					const result = primitive.impl(args, host);
					if (typeof result === "string" && Buffer.byteLength(result, "utf8") > limits.maxStringBytes) {
						throw new LatticeError("bound", "string exceeds policy");
					}
					values.push(result);
					break;
				}
				case "field": {
					const record = values.pop() as { [name: string]: Value };
					values.push(record[item.name]);
					break;
				}
				case "record": {
					const parts = values.splice(values.length - item.keys.length);
					const record: { [name: string]: Value } = {};
					item.keys.forEach((key, index) => {
						record[key] = parts[index];
					});
					values.push(record);
					break;
				}
				case "iter":
					startLoop(item.expr, item.env, values.pop()!);
					break;
				case "loop": {
					const result = values.pop()!;
					const { expr, items, index } = item;
					if (expr.node === "map" || expr.node === "sort") item.out.push(result);
					else if (result) item.out.push(items[index]);
					const next = index + 1;
					if (next < items.length) {
						item.index = next;
						work.push(item, {
							k: "eval",
							expr: expr.node === "sort" ? expr.key : expr.body,
							env: bind(item.env, expr.param, items[next]),
						});
					} else if (expr.node === "sort") {
						charge(sortCost(items.length));
						options.profile?.set("sort", (options.profile.get("sort") ?? 0) + sortCost(items.length));
						values.push(stableSortByKeys(items, item.out));
					} else values.push(item.out);
					break;
				}
				case "fold_list": {
					const items = values.pop() as Value[];
					if (items.length > item.expr.maxItems) throw new LatticeError("bound", "fold input exceeds maxItems");
					work.push(
						{ k: "fold_init", expr: item.expr, env: item.env, items },
						{ k: "eval", expr: item.expr.init, env: item.env },
					);
					break;
				}
				case "fold_init": {
					if (item.items.length === 0) break; // the init value stays on the stack as the result
					const acc = values.pop()!;
					work.push(
						{ k: "fold", expr: item.expr, env: item.env, items: item.items, index: 0 },
						{
							k: "eval",
							expr: item.expr.body,
							env: bind(bind(item.env, item.expr.item, item.items[0]), item.expr.acc, acc),
						},
					);
					break;
				}
				case "fold": {
					const next = item.index + 1;
					if (next >= item.items.length) break; // the last accumulator is the result
					const acc = values.pop()!;
					item.index = next;
					work.push(item, {
						k: "eval",
						expr: item.expr.body,
						env: bind(bind(item.env, item.expr.item, item.items[next]), item.expr.acc, acc),
					});
					break;
				}
				case "skill_call": {
					const skill = options.library.get(item.expr.hash);
					if (!skill) throw new LatticeError("type", "missing skill");
					if (callDepth + 1 > limits.maxSkillCallDepth)
						throw new LatticeError("bound", "skill call depth exceeded");
					const args = values.splice(values.length - item.expr.args.length);
					let env: Env | undefined;
					skill.params.forEach((param, index) => {
						env = bind(env, param.name, args[index]);
					});
					callDepth++;
					work.push({ k: "skill_return" }, { k: "eval", expr: skill.body, env });
					break;
				}
				case "skill_return":
					callDepth--;
					break;
			}
		}
		const value = values.pop()!;
		checkOutputSize(value, limits);
		return { ok: true, value, metrics };
	} catch (error) {
		if (error instanceof LatticeError)
			return { ok: false, error: { code: error.code, message: error.message }, metrics };
		throw error;
	}
}
