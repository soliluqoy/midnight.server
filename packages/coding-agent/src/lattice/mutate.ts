import { canonical } from "./canonical.ts";
import {
	bindersFor,
	children,
	countNodes,
	type Expr,
	exprEquals,
	freeVars,
	getAt,
	type Program,
	replaceAt,
	substitute,
	walk,
} from "./ir.ts";
import { PRIMITIVES } from "./primitives.ts";
import type { NodeInfo } from "./typecheck.ts";

/**
 * Mutation operators (spec sections 11.1 and 40.3). Each operator states its precondition and
 * checks it with the facts the type checker inferred (purity, totality, bounds). Operators whose
 * precondition is provable preserve semantics by construction; `drop_conjunct` is a proposal
 * whose soundness cannot be shown statically, so only evaluation evidence can accept it and a
 * counterexample rejects it (section 39.4: require evidence or reject).
 */
export const MUTATION_OPS = [
	"swap_independent",
	"reorder_exclusive",
	"hoist_common",
	"hoist_invariant",
	"insert_implied_guard",
	"fuse_filters",
	"split_filter",
	"dedupe_conjunct",
	"drop_conjunct",
] as const;

export type MutationOp = (typeof MUTATION_OPS)[number];

/** Operators whose precondition does not establish equivalence. */
export const EVIDENCE_ONLY: ReadonlySet<MutationOp> = new Set(["drop_conjunct"]);

export interface Mutation {
	op: MutationOp;
	description: string;
	program: Program;
}

type Info = ReadonlyMap<Expr, NodeInfo>;

const pureTotal = (info: Info, expr: Expr) => {
	const facts = info.get(expr);
	return facts?.total && facts.effects.size === 1 && facts.effects.has("pure");
};

function atPath(program: Program, path: readonly number[], replacement: Expr): Program {
	return { ...program, body: replaceAt(program.body, path, replacement) };
}

function allNames(expr: Expr): Set<string> {
	const names = new Set<string>();
	walk(expr, (node) => {
		if (node.node === "var" || node.node === "let") names.add(node.name);
		if (node.node === "map" || node.node === "filter" || node.node === "sort") names.add(node.param);
		if (node.node === "fold") {
			names.add(node.item);
			names.add(node.acc);
		}
	});
	return names;
}

function fresh(expr: Expr, base: string): string {
	const used = allNames(expr);
	for (let i = 0; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

/** Each disjunct `eq(subject, const)`: returns the subject and constant set, or undefined. */
function equalitySet(cond: Expr): { subject: string; constants: Set<string> } | undefined {
	const terms = cond.node === "or" ? cond.args : [cond];
	let subject: string | undefined;
	const constants = new Set<string>();
	for (const term of terms) {
		if (term.node !== "call" || term.op !== "eq" || term.args.length !== 2) return undefined;
		const [left, right] = term.args;
		const constant = right.node === "const" ? right : left.node === "const" ? left : undefined;
		const other = constant === right ? left : right;
		if (!constant || other.node === "const") return undefined;
		const key = canonical(other);
		if (subject !== undefined && subject !== key) return undefined;
		subject = key;
		constants.add(canonical(constant.value));
	}
	return subject === undefined ? undefined : { subject, constants };
}

function disjoint(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	for (const value of a) if (b.has(value)) return false;
	return true;
}

export function enumerateMutations(program: Program, info: Info, allowed: ReadonlySet<MutationOp>): Mutation[] {
	const out: Mutation[] = [];
	const nodes: { node: Expr; path: number[] }[] = [];
	walk(program.body, (node, path) => nodes.push({ node, path: [...path] }));

	for (const { node, path } of nodes) {
		if ((node.node === "and" || node.node === "or") && node.args.length >= 2) {
			if (allowed.has("swap_independent")) {
				// Short-circuit order is free when both operands are pure and total.
				for (let i = 0; i < node.args.length - 1; i++) {
					if (!pureTotal(info, node.args[i]) || !pureTotal(info, node.args[i + 1])) continue;
					const args = node.args.slice();
					[args[i], args[i + 1]] = [args[i + 1], args[i]];
					out.push({
						op: "swap_independent",
						description: `swap ${node.node} operands ${i} and ${i + 1} at /${path.join("/")}`,
						program: atPath(program, path, { ...node, args }),
					});
				}
			}
			if (allowed.has("dedupe_conjunct")) {
				for (let i = 1; i < node.args.length; i++) {
					const duplicate = node.args.slice(0, i).some((earlier) => exprEquals(earlier, node.args[i]));
					if (!duplicate || !pureTotal(info, node.args[i])) continue;
					out.push({
						op: "dedupe_conjunct",
						description: `remove duplicate ${node.node} operand ${i} at /${path.join("/")}`,
						program: atPath(program, path, { ...node, args: node.args.filter((_, index) => index !== i) }),
					});
				}
			}
			if (allowed.has("drop_conjunct") && node.node === "and") {
				for (let i = 0; i < node.args.length; i++) {
					out.push({
						op: "drop_conjunct",
						description: `drop and-operand ${i} at /${path.join("/")} (needs evidence)`,
						program: atPath(program, path, { ...node, args: node.args.filter((_, index) => index !== i) }),
					});
				}
			}
		}

		if (node.node === "call" && node.op === "eq" && allowed.has("insert_implied_guard")) {
			const guarded = impliedGuard(program, node, path, info);
			if (guarded) out.push(guarded);
		}

		if (node.node === "if" && node.ifFalse.node === "if" && allowed.has("reorder_exclusive")) {
			// if(A, x, if(B, y, z)) -> if(B, y, if(A, x, z)) when A and B cannot both hold.
			const inner = node.ifFalse;
			const a = equalitySet(node.cond);
			const b = equalitySet(inner.cond);
			if (
				a &&
				b &&
				a.subject === b.subject &&
				disjoint(a.constants, b.constants) &&
				pureTotal(info, node.cond) &&
				pureTotal(info, inner.cond)
			) {
				out.push({
					op: "reorder_exclusive",
					description: `move exclusive branch ahead at /${path.join("/")}`,
					program: atPath(program, path, {
						node: "if",
						cond: inner.cond,
						ifTrue: inner.ifTrue,
						ifFalse: { node: "if", cond: node.cond, ifTrue: node.ifTrue, ifFalse: inner.ifFalse },
					}),
				});
			}
		}

		if (node.node === "filter" && node.list.node === "filter" && allowed.has("fuse_filters")) {
			// filter(filter(L, p), q) -> filter(L, and(p, q)): same items, per-item evaluation order.
			const innerFilter = node.list;
			if (pureTotal(info, innerFilter.body) && pureTotal(info, node.body) && pureTotal(info, node)) {
				const q = substitute(node.body, new Map([[node.param, { node: "var", name: innerFilter.param } as Expr]]));
				const capture = freeVars(node.body);
				capture.delete(node.param);
				if (!capture.has(innerFilter.param)) {
					const p = innerFilter.body;
					const args = [...(p.node === "and" ? p.args : [p]), ...(q.node === "and" ? q.args : [q])];
					out.push({
						op: "fuse_filters",
						description: `fuse nested filters at /${path.join("/")}`,
						program: atPath(program, path, {
							node: "filter",
							list: innerFilter.list,
							param: innerFilter.param,
							body: { node: "and", args },
							maxItems: Math.min(innerFilter.maxItems, node.maxItems),
						}),
					});
				}
			}
		}

		if (
			node.node === "filter" &&
			node.body.node === "and" &&
			node.body.args.length >= 2 &&
			allowed.has("split_filter")
		) {
			if (pureTotal(info, node.body) && pureTotal(info, node)) {
				const [first, ...rest] = node.body.args;
				out.push({
					op: "split_filter",
					description: `split filter predicate at /${path.join("/")}`,
					program: atPath(program, path, {
						...node,
						list: { ...node, body: first },
						body: rest.length === 1 ? rest[0] : { node: "and", args: rest },
					}),
				});
			}
		}
	}

	if (allowed.has("hoist_common")) out.push(...hoistCommon(program, info));
	if (allowed.has("hoist_invariant")) out.push(...hoistInvariant(program, info));
	return out;
}

/**
 * Common-subexpression hoisting: a pure, total subexpression that occurs more than once below a
 * node, with its free variables unchanged along every path, is bound once in a `let`. Totality
 * matters: hoisting evaluates the expression even where the original would not have.
 */
function hoistCommon(program: Program, info: Info): Mutation[] {
	const groups = new Map<string, { expr: Expr; paths: number[][] }>();
	walk(program.body, (node, path) => {
		if (node.node === "var" || node.node === "const" || node.node === "input") return;
		if (countNodes(node) < 3 || !pureTotal(info, node)) return;
		const key = canonical(node);
		const group = groups.get(key) ?? { expr: node, paths: [] };
		group.paths.push([...path]);
		groups.set(key, group);
	});
	const isPrefix = (q: readonly number[], p: readonly number[]) =>
		q.length < p.length && q.every((v, i) => p[i] === v);
	const repeated = [...groups.values()].filter((group) => group.paths.length >= 2);
	const out: Mutation[] = [];
	for (const { expr, paths } of repeated) {
		// Occurrences nested inside another occurrence are covered by the outer one.
		const outer = paths.filter((p) => !paths.some((q) => q !== p && isPrefix(q, p)));
		if (outer.length < 2) continue;
		// Maximal repeats only: skip a group whose every copy sits inside a copy of a larger repeat.
		const dominated = outer.every((p) =>
			repeated.some((other) => other.expr !== expr && other.paths.some((q) => isPrefix(q, p))),
		);
		if (dominated) continue;
		let lca: number[] = outer[0];
		for (const p of outer.slice(1)) {
			let i = 0;
			while (i < lca.length && i < p.length && lca[i] === p[i]) i++;
			lca = lca.slice(0, i);
		}
		// The binding must see the same free variables every occurrence sees.
		const free = freeVars(expr);
		const rebinds = outer.some((p) => {
			let node = getAt(program.body, lca);
			for (const index of p.slice(lca.length)) {
				if (bindersFor(node, index).some((name) => free.has(name))) return true;
				node = children(node)[index];
			}
			return false;
		});
		if (rebinds) continue;
		const name = fresh(program.body, "h");
		let target = getAt(program.body, lca);
		for (const p of outer) target = replaceAt(target, p.slice(lca.length), { node: "var", name });
		out.push({
			op: "hoist_common",
			description: `bind ${outer.length} copies of a ${countNodes(expr)}-node expression once at /${lca.join("/")}`,
			program: atPath(program, lca, { node: "let", name, value: expr, body: target }),
		});
	}
	return out;
}

/**
 * Loop-invariant hoisting: inside the body of a map, filter, sort or fold, a pure, total
 * subexpression that uses none of the variables bound by the loop (or inside it) computes the
 * same value on every iteration, so it is bound once in a `let` just outside the loop. Only
 * maximal invariant subtrees are taken. Totality matters because the loop may run zero times.
 */
function hoistInvariant(program: Program, info: Info): Mutation[] {
	const out: Mutation[] = [];
	const loops: { node: Expr; path: number[] }[] = [];
	walk(program.body, (node, path) => {
		if (node.node === "map" || node.node === "filter" || node.node === "sort" || node.node === "fold") {
			loops.push({ node, path: [...path] });
		}
	});
	for (const { node, path } of loops) {
		const bodyIndex = node.node === "fold" ? 2 : 1;
		const found: { rel: number[]; expr: Expr }[] = [];
		const visit = (expr: Expr, rel: number[], bound: ReadonlySet<string>) => {
			const invariant =
				expr.node !== "var" &&
				expr.node !== "const" &&
				expr.node !== "input" &&
				countNodes(expr) >= 3 &&
				pureTotal(info, expr) &&
				[...freeVars(expr)].every((name) => !bound.has(name));
			if (invariant) {
				found.push({ rel, expr });
				return;
			}
			children(expr).forEach((child, index) => {
				const extra = bindersFor(expr, index);
				visit(child, [...rel, index], extra.length === 0 ? bound : new Set([...bound, ...extra]));
			});
		};
		visit(children(node)[bodyIndex], [bodyIndex], new Set(bindersFor(node, bodyIndex)));
		const groups = new Map<string, { expr: Expr; rels: number[][] }>();
		for (const { rel, expr } of found) {
			const key = canonical(expr);
			const group = groups.get(key) ?? { expr, rels: [] };
			group.rels.push(rel);
			groups.set(key, group);
		}
		for (const { expr, rels } of groups.values()) {
			const name = fresh(program.body, "k");
			let target = node;
			for (const rel of rels) target = replaceAt(target, rel, { node: "var", name });
			out.push({
				op: "hoist_invariant",
				description: `hoist a ${countNodes(expr)}-node loop-invariant expression out of the ${node.node} at /${path.join("/")}`,
				program: atPath(program, path, { node: "let", name, value: expr, body: target }),
			});
		}
	}
	return out;
}

/**
 * Implied-guard insertion: `eq(P(a...), P(b...))` for a primitive P that declares
 * `equalityImplies` (argument positions whose equality follows from equal results, guaranteed by
 * the kernel's implementation) becomes `and(eq(a_i, b_i)..., eq(P(a...), P(b...)))`. When the
 * cheap guard is false the result is false either way, so P is not evaluated. Example:
 * `content_hash(path, size)` only returns for a file of exactly `size` bytes, so two equal
 * digests have equal sizes; comparing sizes first skips hashing files that cannot match.
 * The guard's operands must be pure and total; the guarded comparison may have effects, which
 * the rewrite only ever skips, never reorders or adds.
 */
function impliedGuard(
	program: Program,
	node: Extract<Expr, { node: "call" }>,
	path: readonly number[],
	info: Info,
): Mutation | undefined {
	const [left, right] = node.args;
	if (left?.node !== "call" || right?.node !== "call" || left.op !== right.op) return undefined;
	const implied = PRIMITIVES.get(left.op)?.equalityImplies;
	if (!implied || implied.length === 0) return undefined;
	const guards: Expr[] = [];
	for (const index of implied) {
		const a = left.args[index];
		const b = right.args[index];
		if (!a || !b || !pureTotal(info, a) || !pureTotal(info, b)) return undefined;
		guards.push({ node: "call", op: "eq", args: [a, b] });
	}
	// Already guarded: the comparison sits in an `and` right after the same guards.
	if (path.length > 0) {
		const parent = getAt(program.body, path.slice(0, -1));
		const position = path[path.length - 1];
		if (parent.node === "and") {
			const before = parent.args.slice(Math.max(0, position - guards.length), position);
			if (before.length === guards.length && before.every((expr, i) => exprEquals(expr, guards[i])))
				return undefined;
		}
	}
	return {
		op: "insert_implied_guard",
		description: `compare ${left.op} argument${implied.length > 1 ? "s" : ""} ${implied.join(", ")} before its results at /${path.join("/")}`,
		program: atPath(program, path, { node: "and", args: [...guards, node] }),
	};
}

/** Operator histogram: the coarse structural family used for archive diversity (section 11.4). */
export function operatorFamily(program: Program): string {
	const counts = new Map<string, number>();
	walk(program.body, (node) => {
		const key = node.node === "call" ? `call:${node.op}` : node.node;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	});
	return canonical([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
