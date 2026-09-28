import {
	type Expr,
	IR_VERSION,
	type LibrarySkill,
	type Program,
	T,
	type Type,
	typeEquals,
	typeToString,
	type Value,
	walk,
} from "./ir.ts";
import type { ExecutionLimits } from "./limits.ts";
import { type Effect, PRIMITIVES, type Summary } from "./primitives.ts";

/**
 * Static admission (spec sections 8.7 and 39.3). A candidate is rejected before it runs if a
 * node is malformed, an operator receives the wrong type, a variable is unbound, a loop lacks a
 * bound within policy, a call names a missing skill, or its effects exceed the grant. For every
 * node the checker infers (type, effects, totality, upper-bound summary); mutation operators use
 * totality to decide what may be reordered or hoisted (section 39.4).
 */
export interface CheckOptions {
	limits: ExecutionLimits;
	granted: ReadonlySet<Effect>;
	library: ReadonlyMap<string, LibrarySkill>;
	/** Bounds the contract guarantees for validated inputs. */
	inputSummary: Summary;
}

export interface NodeInfo {
	type: Type;
	effects: ReadonlySet<Effect>;
	/** Cannot fail for any input within the contract's bounds. */
	total: boolean;
	summary: Summary;
}

export type CheckResult =
	| {
			ok: true;
			type: Type;
			effects: Effect[];
			nodes: number;
			depth: number;
			total: boolean;
			info: ReadonlyMap<Expr, NodeInfo>;
	  }
	| { ok: false; error: string };

class CheckError extends Error {}

const NODE_KINDS = new Set([
	"input",
	"const",
	"var",
	"let",
	"if",
	"and",
	"or",
	"call",
	"field",
	"record",
	"map",
	"filter",
	"fold",
	"sort",
	"skill",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isName = (value: unknown) => typeof value === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(value);

function validateType(value: unknown, depth = 0): Type {
	if (depth > 8 || !isObject(value)) throw new CheckError("malformed type");
	switch (value.kind) {
		case "bool":
		case "int":
		case "string":
			return { kind: value.kind };
		case "list":
			return T.list(validateType(value.item, depth + 1));
		case "record": {
			if (!isObject(value.fields)) throw new CheckError("malformed record type");
			const fields: { [name: string]: Type } = {};
			for (const [name, field] of Object.entries(value.fields)) {
				if (!isName(name)) throw new CheckError(`bad field name ${JSON.stringify(name)}`);
				fields[name] = validateType(field, depth + 1);
			}
			return T.record(fields);
		}
		default:
			throw new CheckError(`unknown type kind ${JSON.stringify(value.kind)}`);
	}
}

/**
 * Structural validation of untrusted JSON, iteratively and before any recursive pass, so a
 * deeply nested or oversized AST is rejected without exhausting the host stack.
 */
function validateShape(root: unknown, limits: ExecutionLimits): { nodes: number; depth: number } {
	const stack: [unknown, number][] = [[root, 1]];
	let nodes = 0;
	let maxDepth = 0;
	while (stack.length > 0) {
		const [value, depth] = stack.pop()!;
		nodes++;
		maxDepth = Math.max(maxDepth, depth);
		if (nodes > limits.maxNodes) throw new CheckError(`program exceeds ${limits.maxNodes} nodes`);
		if (depth > limits.maxDepth) throw new CheckError(`program exceeds depth ${limits.maxDepth}`);
		if (!isObject(value) || typeof value.node !== "string" || !NODE_KINDS.has(value.node)) {
			throw new CheckError("malformed node");
		}
		const push = (...kids: unknown[]) => {
			for (const kid of kids) stack.push([kid, depth + 1]);
		};
		const needArray = (field: string) => {
			const items = value[field];
			if (!Array.isArray(items)) throw new CheckError(`${value.node}.${field} must be an array`);
			return items;
		};
		const needName = (field: string) => {
			if (!isName(value[field])) throw new CheckError(`${value.node}.${field} must be a name`);
		};
		const needBound = () => {
			const bound = value.maxItems;
			if (typeof bound !== "number" || !Number.isInteger(bound) || bound < 1) {
				throw new CheckError(`${value.node} needs a positive integer maxItems`);
			}
			if (bound > limits.maxItems) throw new CheckError(`${value.node} maxItems exceeds policy ${limits.maxItems}`);
		};
		switch (value.node) {
			case "input":
				break;
			case "const":
				validateType(value.type);
				if (!("value" in value)) throw new CheckError("const needs a value");
				break;
			case "var":
				needName("name");
				break;
			case "let":
				needName("name");
				push(value.value, value.body);
				break;
			case "if":
				push(value.cond, value.ifTrue, value.ifFalse);
				break;
			case "and":
			case "or": {
				const args = needArray("args");
				if (args.length === 0) throw new CheckError(`${value.node} needs arguments`);
				push(...args);
				break;
			}
			case "call":
				if (typeof value.op !== "string") throw new CheckError("call.op must be a string");
				push(...needArray("args"));
				break;
			case "skill":
				if (typeof value.hash !== "string" || !/^[0-9a-f]{64}$/.test(value.hash)) {
					throw new CheckError("skill.hash must be a sha256 hex digest");
				}
				push(...needArray("args"));
				break;
			case "field":
				needName("name");
				push(value.record);
				break;
			case "record": {
				if (!isObject(value.fields)) throw new CheckError("record.fields must be an object");
				for (const name of Object.keys(value.fields)) {
					if (!isName(name)) throw new CheckError(`bad field name ${JSON.stringify(name)}`);
				}
				push(...Object.values(value.fields));
				break;
			}
			case "map":
			case "filter":
				needName("param");
				needBound();
				push(value.list, value.body);
				break;
			case "sort":
				needName("param");
				needBound();
				push(value.list, value.key);
				break;
			case "fold":
				needName("item");
				needName("acc");
				needBound();
				push(value.list, value.init, value.body);
				break;
		}
	}
	return { nodes, depth: maxDepth };
}

export function validateValue(type: Type, value: unknown, limits: ExecutionLimits, depth = 0): Value {
	if (depth > 16) throw new CheckError("value nesting too deep");
	switch (type.kind) {
		case "bool":
			if (typeof value !== "boolean") throw new CheckError("expected Bool");
			return value;
		case "int":
			if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new CheckError("expected Int");
			return value;
		case "string":
			if (typeof value !== "string") throw new CheckError("expected String");
			if (Buffer.byteLength(value, "utf8") > limits.maxStringBytes) throw new CheckError("string too long");
			return value;
		case "list":
			if (!Array.isArray(value)) throw new CheckError("expected List");
			if (value.length > limits.maxItems) throw new CheckError("list too long");
			return value.map((item) => validateValue(type.item, item, limits, depth + 1));
		case "record": {
			if (!isObject(value)) throw new CheckError("expected Record");
			const expected = Object.keys(type.fields).sort();
			const actual = Object.keys(value).sort();
			if (expected.length !== actual.length || expected.some((key, i) => key !== actual[i])) {
				throw new CheckError(`record fields must be exactly ${expected.join(", ")}`);
			}
			const out: { [name: string]: Value } = {};
			for (const key of expected) out[key] = validateValue(type.fields[key], value[key], limits, depth + 1);
			return out;
		}
	}
}

export function summaryOfValue(type: Type, value: Value): Summary {
	switch (type.kind) {
		case "bool":
			return {};
		case "int":
			return { mag: Math.abs(value as number) };
		case "string":
			return { bytes: Buffer.byteLength(value as string, "utf8") };
		case "list": {
			const items = value as Value[];
			if (items.length === 0) return { card: 0 };
			return { card: items.length, item: items.map((item) => summaryOfValue(type.item, item)).reduce(joinSummary) };
		}
		case "record": {
			const record = value as { [name: string]: Value };
			const fields: { [name: string]: Summary } = {};
			for (const key of Object.keys(type.fields)) fields[key] = summaryOfValue(type.fields[key], record[key]);
			return { fields };
		}
	}
}

/** Least upper bound: the larger bound where both sides know one, unknown otherwise. */
export function joinSummary(a: Summary, b: Summary): Summary {
	const max = (x: number | undefined, y: number | undefined) =>
		x === undefined || y === undefined ? undefined : Math.max(x, y);
	const out: Summary = {};
	const card = max(a.card, b.card);
	const mag = max(a.mag, b.mag);
	const bytes = max(a.bytes, b.bytes);
	if (card !== undefined) out.card = card;
	if (mag !== undefined) out.mag = mag;
	if (bytes !== undefined) out.bytes = bytes;
	if (a.item && b.item) out.item = joinSummary(a.item, b.item);
	if (a.fields && b.fields) {
		out.fields = {};
		for (const key of Object.keys(a.fields)) {
			if (b.fields[key]) out.fields[key] = joinSummary(a.fields[key], b.fields[key]);
		}
	}
	return out;
}

interface Binding {
	type: Type;
	summary: Summary;
}

export function checkProgram(program: unknown, options: CheckOptions): CheckResult {
	try {
		if (!isObject(program) || program.ir_version !== IR_VERSION) throw new CheckError("unsupported IR version");
		const inputType = validateType(program.input_type);
		const outputType = validateType(program.output_type);
		const shape = validateShape(program.body, options.limits);
		const info = new Map<Expr, NodeInfo>();
		const root = inferExpr(program.body as Expr, inputType, options, info);
		if (!typeEquals(root.type, outputType)) {
			throw new CheckError(`program returns ${typeToString(root.type)}, declared ${typeToString(outputType)}`);
		}
		for (const effect of root.effects) {
			if (effect !== "pure" && !options.granted.has(effect)) throw new CheckError(`undeclared effect: ${effect}`);
		}
		return {
			ok: true,
			type: root.type,
			effects: [...root.effects].sort(),
			nodes: shape.nodes,
			depth: shape.depth,
			total: root.total,
			info,
		};
	} catch (error) {
		if (error instanceof CheckError) return { ok: false, error: error.message };
		throw error;
	}
}

/** Check a library skill body against its parameter types. */
export function checkLibrarySkill(skill: LibrarySkill, options: CheckOptions): CheckResult {
	try {
		const shape = validateShape(skill.body, options.limits);
		walk(skill.body, (node) => {
			if (node.node === "input") throw new CheckError("library abstractions cannot read the program input");
		});
		const env = new Map<string, Binding>();
		for (const param of skill.params) {
			if (!isName(param.name)) throw new CheckError("bad parameter name");
			env.set(param.name, { type: validateType(param.type), summary: {} });
		}
		const info = new Map<Expr, NodeInfo>();
		const root = infer(skill.body, env, T.bool, options, info, 0);
		if (root.effects.size > 1 || !root.effects.has("pure")) {
			throw new CheckError("library abstractions must be pure");
		}
		return {
			ok: true,
			type: root.type,
			effects: [...root.effects],
			nodes: shape.nodes,
			depth: shape.depth,
			total: root.total,
			info,
		};
	} catch (error) {
		if (error instanceof CheckError) return { ok: false, error: error.message };
		throw error;
	}
}

function inferExpr(body: Expr, inputType: Type, options: CheckOptions, info: Map<Expr, NodeInfo>): NodeInfo {
	return infer(body, new Map(), inputType, options, info, 0);
}

function infer(
	expr: Expr,
	env: ReadonlyMap<string, Binding>,
	inputType: Type,
	options: CheckOptions,
	info: Map<Expr, NodeInfo>,
	callDepth: number,
): NodeInfo {
	const sub = (child: Expr, extra?: Map<string, Binding>) =>
		infer(child, extra ? new Map([...env, ...extra]) : env, inputType, options, info, callDepth);
	const effectsOf = (...parts: NodeInfo[]) => {
		const effects = new Set<Effect>(["pure"]);
		for (const part of parts) for (const effect of part.effects) effects.add(effect);
		return effects;
	};
	let result: NodeInfo;
	switch (expr.node) {
		case "input":
			result = { type: inputType, effects: new Set(["pure"]), total: true, summary: options.inputSummary };
			break;
		case "const": {
			const type = validateType(expr.type);
			const value = validateValue(type, expr.value, options.limits);
			result = { type, effects: new Set(["pure"]), total: true, summary: summaryOfValue(type, value) };
			break;
		}
		case "var": {
			const binding = env.get(expr.name);
			if (!binding) throw new CheckError(`unbound variable ${expr.name}`);
			result = { type: binding.type, effects: new Set(["pure"]), total: true, summary: binding.summary };
			break;
		}
		case "let": {
			const value = sub(expr.value);
			const body = sub(expr.body, new Map([[expr.name, { type: value.type, summary: value.summary }]]));
			result = {
				type: body.type,
				effects: effectsOf(value, body),
				total: value.total && body.total,
				summary: body.summary,
			};
			break;
		}
		case "if": {
			const cond = sub(expr.cond);
			if (cond.type.kind !== "bool") throw new CheckError("if condition must be Bool");
			const a = sub(expr.ifTrue);
			const b = sub(expr.ifFalse);
			if (!typeEquals(a.type, b.type)) throw new CheckError("if branches must have the same type");
			result = {
				type: a.type,
				effects: effectsOf(cond, a, b),
				total: cond.total && a.total && b.total,
				summary: joinSummary(a.summary, b.summary),
			};
			break;
		}
		case "and":
		case "or": {
			const args = expr.args.map((arg) => sub(arg));
			if (args.some((arg) => arg.type.kind !== "bool")) throw new CheckError(`${expr.node} arguments must be Bool`);
			result = { type: T.bool, effects: effectsOf(...args), total: args.every((arg) => arg.total), summary: {} };
			break;
		}
		case "call": {
			const primitive = PRIMITIVES.get(expr.op);
			if (!primitive) throw new CheckError(`unknown primitive ${expr.op}`);
			const args = expr.args.map((arg) => sub(arg));
			const type = primitive.signature(args.map((arg) => arg.type));
			if (typeof type === "string") throw new CheckError(type);
			const effects = effectsOf(...args);
			effects.add(primitive.effect);
			const summaries = args.map((arg) => arg.summary);
			result = {
				type,
				effects,
				total: args.every((arg) => arg.total) && primitive.total(summaries),
				summary: primitive.summarize(summaries),
			};
			break;
		}
		case "field": {
			const record = sub(expr.record);
			if (record.type.kind !== "record" || !(expr.name in record.type.fields)) {
				throw new CheckError(`no field ${expr.name} on ${typeToString(record.type)}`);
			}
			result = {
				type: record.type.fields[expr.name],
				effects: record.effects,
				total: record.total,
				summary: record.summary.fields?.[expr.name] ?? {},
			};
			break;
		}
		case "record": {
			const fields: { [name: string]: Type } = {};
			const summaries: { [name: string]: Summary } = {};
			const parts: NodeInfo[] = [];
			for (const key of Object.keys(expr.fields).sort()) {
				const part = sub(expr.fields[key]);
				fields[key] = part.type;
				summaries[key] = part.summary;
				parts.push(part);
			}
			result = {
				type: T.record(fields),
				effects: effectsOf(...parts),
				total: parts.every((part) => part.total),
				summary: { fields: summaries },
			};
			break;
		}
		case "map":
		case "filter":
		case "sort": {
			const list = sub(expr.list);
			if (list.type.kind !== "list") throw new CheckError(`${expr.node} needs a List`);
			const item: Binding = { type: list.type.item, summary: list.summary.item ?? {} };
			const bodyExpr = expr.node === "sort" ? expr.key : expr.body;
			const body = sub(bodyExpr, new Map([[expr.param, item]]));
			const withinBound = list.summary.card !== undefined && list.summary.card <= expr.maxItems;
			const card = list.summary.card !== undefined ? Math.min(list.summary.card, expr.maxItems) : expr.maxItems;
			let type: Type = list.type;
			let itemSummary = list.summary.item;
			if (expr.node === "filter" && body.type.kind !== "bool") throw new CheckError("filter predicate must be Bool");
			if (expr.node === "sort" && body.type.kind !== "int" && body.type.kind !== "string") {
				throw new CheckError("sort key must be Int or String");
			}
			if (expr.node === "map") {
				type = T.list(body.type);
				itemSummary = body.summary;
			}
			const summary: Summary = { card };
			if (itemSummary) summary.item = itemSummary;
			result = { type, effects: effectsOf(list, body), total: list.total && body.total && withinBound, summary };
			break;
		}
		case "fold": {
			const list = sub(expr.list);
			if (list.type.kind !== "list") throw new CheckError("fold needs a List");
			const init = sub(expr.init);
			const body = sub(
				expr.body,
				new Map<string, Binding>([
					[expr.item, { type: list.type.item, summary: list.summary.item ?? {} }],
					[expr.acc, { type: init.type, summary: {} }],
				]),
			);
			if (!typeEquals(body.type, init.type)) throw new CheckError("fold body must return the accumulator type");
			const withinBound = list.summary.card !== undefined && list.summary.card <= expr.maxItems;
			// The accumulator's bounds are not tracked, so anything that can overflow on it is non-total.
			result = {
				type: init.type,
				effects: effectsOf(list, init, body),
				total: list.total && init.total && body.total && withinBound,
				summary: {},
			};
			break;
		}
		case "skill": {
			const skill = options.library.get(expr.hash);
			if (!skill) throw new CheckError(`call references missing skill ${expr.hash.slice(0, 12)}`);
			if (callDepth + 1 > options.limits.maxSkillCallDepth) throw new CheckError("skill call depth exceeds policy");
			if (skill.params.length !== expr.args.length) throw new CheckError(`skill ${skill.name} arity mismatch`);
			const args = expr.args.map((arg) => sub(arg));
			const env2 = new Map<string, Binding>();
			skill.params.forEach((param, index) => {
				if (!typeEquals(param.type, args[index].type)) {
					throw new CheckError(`skill ${skill.name} parameter ${param.name} expects ${typeToString(param.type)}`);
				}
				env2.set(param.name, { type: param.type, summary: args[index].summary });
			});
			// Bodies are checked per call site so bounds flow through; results go to a scratch map.
			const body = infer(skill.body, env2, inputType, options, new Map(), callDepth + 1);
			result = {
				type: body.type,
				effects: effectsOf(body, ...args),
				total: body.total && args.every((arg) => arg.total),
				summary: body.summary,
			};
			break;
		}
	}
	info.set(expr, result);
	return result;
}

/** Programs are compared and stored as data; this helper admits a program or throws with the reason. */
export function admit(program: Program, options: CheckOptions): Extract<CheckResult, { ok: true }> {
	const result = checkProgram(program, options);
	if (!result.ok) throw new Error(`program rejected: ${result.error}`);
	return result;
}
