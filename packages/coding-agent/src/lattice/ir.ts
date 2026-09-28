import { canonical, digest } from "./canonical.ts";

/**
 * The bounded expression IR (spec sections 8 and 39.1). A program is data, never host code:
 * the kernel type-checks it, then interprets or compiles it under fuel. There is no recursion,
 * no unbounded loop and no dynamic import. Every iterating node carries `maxItems`.
 */
export const IR_VERSION = 1;

export type Type =
	| { kind: "bool" }
	| { kind: "int" }
	| { kind: "string" }
	| { kind: "list"; item: Type }
	| { kind: "record"; fields: { [name: string]: Type } };

export const T = {
	bool: { kind: "bool" } as Type,
	int: { kind: "int" } as Type,
	string: { kind: "string" } as Type,
	list(item: Type): Type {
		return { kind: "list", item };
	},
	record(fields: { [name: string]: Type }): Type {
		return { kind: "record", fields };
	},
};

export type Value = boolean | number | string | Value[] | { [field: string]: Value };

export type Expr =
	| { node: "input" }
	| { node: "const"; type: Type; value: Value }
	| { node: "var"; name: string }
	| { node: "let"; name: string; value: Expr; body: Expr }
	| { node: "if"; cond: Expr; ifTrue: Expr; ifFalse: Expr }
	| { node: "and"; args: Expr[] }
	| { node: "or"; args: Expr[] }
	| { node: "call"; op: string; args: Expr[] }
	| { node: "field"; record: Expr; name: string }
	| { node: "record"; fields: { [name: string]: Expr } }
	| { node: "map"; list: Expr; param: string; body: Expr; maxItems: number }
	| { node: "filter"; list: Expr; param: string; body: Expr; maxItems: number }
	| { node: "fold"; list: Expr; init: Expr; item: string; acc: string; body: Expr; maxItems: number }
	| { node: "sort"; list: Expr; param: string; key: Expr; maxItems: number }
	| { node: "skill"; hash: string; args: Expr[] };

/** A task program: typed input and output around one expression. */
export interface Program {
	ir_version: number;
	input_type: Type;
	output_type: Type;
	body: Expr;
}

/**
 * A library abstraction (spec section 40.7): a closed expression over typed value parameters,
 * pinned by content hash. Skills can call only skills that existed before them, so the hash
 * chain rules out call cycles.
 */
export interface LibrarySkill {
	name: string;
	params: { name: string; type: Type }[];
	body: Expr;
}

export function typeEquals(a: Type, b: Type): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "list" && b.kind === "list") return typeEquals(a.item, b.item);
	if (a.kind === "record" && b.kind === "record") {
		const ak = Object.keys(a.fields).sort();
		const bk = Object.keys(b.fields).sort();
		return ak.length === bk.length && ak.every((key, i) => key === bk[i] && typeEquals(a.fields[key], b.fields[key]));
	}
	return true;
}

export function typeToString(type: Type): string {
	switch (type.kind) {
		case "list":
			return `List<${typeToString(type.item)}>`;
		case "record":
			return `{${Object.keys(type.fields)
				.sort()
				.map((key) => `${key}: ${typeToString(type.fields[key])}`)
				.join(", ")}}`;
		default:
			return type.kind[0].toUpperCase() + type.kind.slice(1);
	}
}

/** Direct children in evaluation order. */
export function children(expr: Expr): Expr[] {
	switch (expr.node) {
		case "input":
		case "const":
		case "var":
			return [];
		case "let":
			return [expr.value, expr.body];
		case "if":
			return [expr.cond, expr.ifTrue, expr.ifFalse];
		case "and":
		case "or":
		case "call":
		case "skill":
			return expr.args;
		case "field":
			return [expr.record];
		case "record":
			return Object.keys(expr.fields)
				.sort()
				.map((key) => expr.fields[key]);
		case "map":
		case "filter":
			return [expr.list, expr.body];
		case "fold":
			return [expr.list, expr.init, expr.body];
		case "sort":
			return [expr.list, expr.key];
	}
}

/** Rebuild `expr` with its children replaced, in the order `children` returns them. */
export function withChildren(expr: Expr, kids: readonly Expr[]): Expr {
	switch (expr.node) {
		case "input":
		case "const":
		case "var":
			return expr;
		case "let":
			return { ...expr, value: kids[0], body: kids[1] };
		case "if":
			return { ...expr, cond: kids[0], ifTrue: kids[1], ifFalse: kids[2] };
		case "and":
		case "or":
		case "call":
		case "skill":
			return { ...expr, args: [...kids] };
		case "field":
			return { ...expr, record: kids[0] };
		case "record": {
			const keys = Object.keys(expr.fields).sort();
			const fields: { [name: string]: Expr } = {};
			keys.forEach((key, i) => {
				fields[key] = kids[i];
			});
			return { node: "record", fields };
		}
		case "map":
		case "filter":
			return { ...expr, list: kids[0], body: kids[1] };
		case "fold":
			return { ...expr, list: kids[0], init: kids[1], body: kids[2] };
		case "sort":
			return { ...expr, list: kids[0], key: kids[1] };
	}
}

/** Names a node binds for which children (by index into `children`). */
export function bindersFor(expr: Expr, childIndex: number): string[] {
	switch (expr.node) {
		case "let":
			return childIndex === 1 ? [expr.name] : [];
		case "map":
		case "filter":
			return childIndex === 1 ? [expr.param] : [];
		case "fold":
			return childIndex === 2 ? [expr.item, expr.acc] : [];
		case "sort":
			return childIndex === 1 ? [expr.param] : [];
		default:
			return [];
	}
}

export function countNodes(expr: Expr): number {
	let count = 0;
	const stack = [expr];
	while (stack.length > 0) {
		const next = stack.pop()!;
		count++;
		stack.push(...children(next));
	}
	return count;
}

export function depthOf(expr: Expr): number {
	let max = 0;
	const stack: [Expr, number][] = [[expr, 1]];
	while (stack.length > 0) {
		const [next, depth] = stack.pop()!;
		max = Math.max(max, depth);
		for (const child of children(next)) stack.push([child, depth + 1]);
	}
	return max;
}

/** Free variables of `expr`. */
export function freeVars(expr: Expr): Set<string> {
	const free = new Set<string>();
	const visit = (node: Expr, bound: ReadonlySet<string>) => {
		if (node.node === "var") {
			if (!bound.has(node.name)) free.add(node.name);
			return;
		}
		children(node).forEach((child, index) => {
			const extra = bindersFor(node, index);
			visit(child, extra.length === 0 ? bound : new Set([...bound, ...extra]));
		});
	};
	visit(expr, new Set());
	return free;
}

/**
 * Rename every binder to its binding position (`v0`, `v1`, ...) so programs that differ only
 * in variable names hash the same (spec section 37.3, rule 6). Free variables keep their names.
 */
export function alphaNormalize(expr: Expr): Expr {
	let counter = 0;
	const visit = (node: Expr, env: ReadonlyMap<string, string>): Expr => {
		if (node.node === "var") return { node: "var", name: env.get(node.name) ?? node.name };
		const fresh: string[] = [];
		const kids = children(node).map((child, index) => {
			const names = bindersFor(node, index);
			if (names.length === 0) return visit(child, env);
			const next = new Map(env);
			for (const name of names) {
				const renamed = `v${counter++}`;
				fresh.push(renamed);
				next.set(name, renamed);
			}
			return visit(child, next);
		});
		const rebuilt = withChildren(node, kids);
		switch (rebuilt.node) {
			case "let":
				return { ...rebuilt, name: fresh[0] };
			case "map":
			case "filter":
			case "sort":
				return { ...rebuilt, param: fresh[0] };
			case "fold":
				return { ...rebuilt, item: fresh[0], acc: fresh[1] };
			default:
				return rebuilt;
		}
	};
	return visit(expr, new Map());
}

/** Content identity of a program: canonical IR plus the primitive library it was typed against. */
export function programHash(program: Program, primitiveLibraryHash: string): string {
	return digest({
		ir_version: program.ir_version,
		input_type: program.input_type,
		output_type: program.output_type,
		body: alphaNormalize(program.body),
		primitives: primitiveLibraryHash,
	});
}

export function librarySkillHash(skill: LibrarySkill, primitiveLibraryHash: string): string {
	// The name is documentation; the identity is the typed body with positional parameters.
	const positional = new Map(skill.params.map((param, index) => [param.name, `p${index}`]));
	return digest({
		params: skill.params.map((param) => param.type),
		body: alphaNormalize(renameFree(skill.body, positional)),
		primitives: primitiveLibraryHash,
	});
}

/** Rename free variables; bound occurrences (shadowing) are left alone. */
export function renameFree(expr: Expr, names: ReadonlyMap<string, string>): Expr {
	const visit = (node: Expr, bound: ReadonlySet<string>): Expr => {
		if (node.node === "var") {
			const renamed = bound.has(node.name) ? undefined : names.get(node.name);
			return renamed ? { node: "var", name: renamed } : node;
		}
		const kids = children(node).map((child, index) => {
			const extra = bindersFor(node, index);
			return visit(child, extra.length === 0 ? bound : new Set([...bound, ...extra]));
		});
		return withChildren(node, kids);
	};
	return visit(expr, new Set());
}

/** Replace free occurrences of variables with expressions (capture is avoided by the caller using fresh names). */
export function substitute(expr: Expr, values: ReadonlyMap<string, Expr>): Expr {
	const visit = (node: Expr, bound: ReadonlySet<string>): Expr => {
		if (node.node === "var") return bound.has(node.name) ? node : (values.get(node.name) ?? node);
		const kids = children(node).map((child, index) => {
			const extra = bindersFor(node, index);
			return visit(child, extra.length === 0 ? bound : new Set([...bound, ...extra]));
		});
		return withChildren(node, kids);
	};
	return visit(expr, new Set());
}

export function encodeProgram(program: Program): string {
	return canonical(program);
}

export function parseProgram(text: string): Program {
	const value = JSON.parse(text) as Program;
	if (typeof value !== "object" || value === null || value.ir_version !== IR_VERSION) {
		throw new Error(`unsupported IR version (expected ${IR_VERSION})`);
	}
	return value;
}

/** Visit every node with its path (child indexes from the root). */
export function walk(expr: Expr, visit: (node: Expr, path: readonly number[]) => void): void {
	const stack: [Expr, number[]][] = [[expr, []]];
	while (stack.length > 0) {
		const [node, path] = stack.pop()!;
		visit(node, path);
		const kids = children(node);
		for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], [...path, i]]);
	}
}

export function getAt(expr: Expr, path: readonly number[]): Expr {
	let node = expr;
	for (const index of path) node = children(node)[index];
	return node;
}

export function replaceAt(expr: Expr, path: readonly number[], replacement: Expr): Expr {
	if (path.length === 0) return replacement;
	const kids = children(expr);
	const [head, ...rest] = path;
	const next = kids.slice();
	next[head] = replaceAt(kids[head], rest, replacement);
	return withChildren(expr, next);
}

/** Binders in scope at `path`. */
export function scopeAt(expr: Expr, path: readonly number[]): string[] {
	const names: string[] = [];
	let node = expr;
	for (const index of path) {
		names.push(...bindersFor(node, index));
		node = children(node)[index];
	}
	return names;
}

export function exprEquals(a: Expr, b: Expr): boolean {
	return canonical(a) === canonical(b);
}
