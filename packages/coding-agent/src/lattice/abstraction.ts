import { canonical } from "./canonical.ts";
import type { EvalContext } from "./evaluator.ts";
import { execute } from "./evaluator.ts";
import {
	alphaNormalize,
	children,
	countNodes,
	type Expr,
	freeVars,
	type LibrarySkill,
	librarySkillHash,
	type Program,
	replaceAt,
	type Type,
	typeEquals,
	type Value,
	walk,
} from "./ir.ts";
import type { ExecutionLimits } from "./limits.ts";
import { type Effect, type Host, PRIMITIVE_LIBRARY_HASH, type Summary } from "./primitives.ts";
import { checkLibrarySkill, checkProgram, type NodeInfo } from "./typecheck.ts";

/**
 * Bounded library learning (spec section 40.7), not full DreamCoder: collect accepted
 * programs, enumerate repeated pure subtrees of 3-12 nodes, anti-unify each group by turning differing
 * leaves (constants, free variables, the program input) into at most three typed parameters,
 * score the description-length saving, rewrite a copy of the corpus, and keep the abstraction
 * only if every rewritten program still type-checks and behaves identically on its cases.
 */
export interface CorpusEntry {
	id: string;
	program: Program;
	inputBounds: Summary;
	/** Inputs used to confirm the rewritten program is equivalent. */
	cases: Value[];
	/** Effects the program's contract grants (default: none). Only pure subtrees are abstracted. */
	granted?: readonly Effect[];
	/** The world each case runs against, for programs with `read` effects. */
	host?: (input: Value) => Host;
}

export interface AbstractionReport {
	skill: LibrarySkill;
	hash: string;
	occurrences: number;
	programs: string[];
	/** Node-count description length: corpus before, corpus after, definition. */
	corpusNodesBefore: number;
	corpusNodesAfter: number;
	definitionNodes: number;
	gain: number;
	verifiedCases: number;
	rewritten: { id: string; program: Program }[];
}

interface Occurrence {
	entry: number;
	path: number[];
	expr: Expr;
	info: ReadonlyMap<Expr, NodeInfo>;
}

/** Structure with leaves abstracted: constants keep only their type; variables and input become holes. */
function skeleton(expr: Expr): string {
	const shape = (node: Expr): unknown => {
		switch (node.node) {
			case "const":
				return ["const", node.type];
			case "var":
			case "input":
				return ["leaf"];
			default:
				return [node.node, strip(node), children(node).map(shape)];
		}
	};
	return canonical(shape(expr));
}

/** Non-child, non-binder fields that define an interior node (operator, field name, bound). */
function strip(node: Expr): unknown {
	switch (node.node) {
		case "call":
			return node.op;
		case "field":
			return node.name;
		case "record":
			return Object.keys(node.fields).sort();
		case "map":
		case "filter":
		case "sort":
		case "fold":
			return node.maxItems;
		case "skill":
			return node.hash;
		default:
			return null;
	}
}

/** Leaf positions (paths inside the subtree) that are not bound inside the subtree. */
function leafPaths(expr: Expr): number[][] {
	const out: number[][] = [];
	const visit = (node: Expr, path: number[], bound: ReadonlySet<string>) => {
		if (node.node === "const" || node.node === "input" || (node.node === "var" && !bound.has(node.name))) {
			out.push(path);
			return;
		}
		children(node).forEach((child, index) => {
			const extra: string[] = [];
			if ((node.node === "map" || node.node === "filter" || node.node === "sort") && index === 1)
				extra.push(node.param);
			if (node.node === "let" && index === 1) extra.push(node.name);
			if (node.node === "fold" && index === 2) extra.push(node.item, node.acc);
			visit(child, [...path, index], extra.length ? new Set([...bound, ...extra]) : bound);
		});
	};
	visit(expr, [], new Set());
	return out;
}

function at(expr: Expr, path: readonly number[]): Expr {
	let node = expr;
	for (const index of path) node = children(node)[index];
	return node;
}

export function mineAbstractions(
	corpus: readonly CorpusEntry[],
	options: {
		limits: ExecutionLimits;
		library: ReadonlyMap<string, LibrarySkill>;
		maxParams?: number;
		namePrefix?: string;
	},
): AbstractionReport[] {
	const maxParams = options.maxParams ?? 3;
	const checks = corpus.map((entry) => {
		const check = checkProgram(entry.program, {
			limits: options.limits,
			granted: new Set(entry.granted),
			library: options.library,
			inputSummary: entry.inputBounds,
		});
		if (!check.ok) throw new Error(`corpus program ${entry.id} rejected: ${check.error}`);
		return check;
	});

	// 1-3: repeated subtrees of 3-12 nodes, grouped by skeleton.
	const groups = new Map<string, Occurrence[]>();
	corpus.forEach((entry, index) => {
		walk(entry.program.body, (node, path) => {
			const size = countNodes(node);
			if (size < 3 || size > 12) return;
			const facts = checks[index].info.get(node);
			if (!facts || facts.effects.size !== 1 || !facts.effects.has("pure")) return;
			const key = skeleton(node);
			const list = groups.get(key) ?? [];
			list.push({ entry: index, path: [...path], expr: node, info: checks[index].info });
			groups.set(key, list);
		});
	});

	const reports: AbstractionReport[] = [];
	for (const occurrences of groups.values()) {
		// Occurrences must not overlap each other.
		const chosen: Occurrence[] = [];
		for (const occurrence of occurrences) {
			const overlaps = chosen.some(
				(other) =>
					other.entry === occurrence.entry &&
					(other.path.every((v, i) => occurrence.path[i] === v) ||
						occurrence.path.every((v, i) => other.path[i] === v)),
			);
			if (!overlaps) chosen.push(occurrence);
		}
		if (chosen.length < 2) continue;

		// 4-5: anti-unify. Leaf positions with the same value in every occurrence stay; others become
		// parameters, shared where the per-occurrence values coincide (e.g. the same record variable).
		const template = chosen[0].expr;
		const leaves = leafPaths(template);
		const params: { name: string; type: Type; signature: string }[] = [];
		const leafParam = new Map<string, string>();
		let valid = true;
		for (const leaf of leaves) {
			const values = chosen.map((occurrence) => at(occurrence.expr, leaf));
			const types = chosen.map((occurrence) => occurrence.info.get(at(occurrence.expr, leaf))?.type);
			if (types.some((type) => !type || !typeEquals(type, types[0]!))) {
				valid = false;
				break;
			}
			const constantEverywhere = values.every(
				(value) => value.node === "const" && canonical(value) === canonical(values[0]),
			);
			if (constantEverywhere) continue;
			const signature = canonical(values);
			let param = params.find((candidate) => candidate.signature === signature);
			if (!param) {
				param = { name: `p${params.length}`, type: types[0]!, signature };
				params.push(param);
			}
			leafParam.set(canonical(leaf), param.name);
		}
		if (!valid || params.length === 0 || params.length > maxParams) continue;
		let body = template;
		for (const leaf of leaves) {
			const name = leafParam.get(canonical(leaf));
			if (name) body = replaceAt(body, leaf, { node: "var", name });
		}
		// Inner binders become v0, v1, ...; parameters (p0, p1, ...) are free and keep their names.
		body = alphaNormalize(body);
		const skill: LibrarySkill = {
			name: `${options.namePrefix ?? "abs"}_${reports.length}`,
			params: params.map(({ name, type }) => ({ name, type })),
			body,
		};
		// 6: no hidden effects, closed body.
		const skillCheck = checkLibrarySkill(skill, {
			limits: options.limits,
			granted: new Set(),
			library: options.library,
			inputSummary: {},
		});
		if (!skillCheck.ok) continue;
		const free = freeVars(body);
		for (const param of params) free.delete(param.name);
		if (free.size > 0) continue;
		const hash = librarySkillHash(skill, PRIMITIVE_LIBRARY_HASH);
		const library = new Map(options.library);
		library.set(hash, skill);

		// 7-8: rewrite a copy of the corpus and measure the description length.
		const rewritten = corpus.map((entry) => ({ id: entry.id, program: entry.program }));
		const byEntry = new Map<number, Occurrence[]>();
		for (const occurrence of chosen)
			byEntry.set(occurrence.entry, [...(byEntry.get(occurrence.entry) ?? []), occurrence]);
		for (const [entryIndex, list] of byEntry) {
			// Deepest and right-most first, so earlier paths stay valid.
			const ordered = [...list].sort((a, b) => canonical(b.path).localeCompare(canonical(a.path)));
			let program = rewritten[entryIndex].program;
			for (const occurrence of ordered) {
				const args = params.map((param) => {
					const leaf = leaves.find((path) => leafParam.get(canonical(path)) === param.name)!;
					return at(occurrence.expr, leaf);
				});
				program = { ...program, body: replaceAt(program.body, occurrence.path, { node: "skill", hash, args }) };
			}
			rewritten[entryIndex] = { id: rewritten[entryIndex].id, program };
		}
		const before = corpus.reduce((sum, entry) => sum + countNodes(entry.program.body), 0);
		const after = rewritten.reduce((sum, entry) => sum + countNodes(entry.program.body), 0);
		const definition = countNodes(body) + params.length;
		const gain = before - after - definition - 1;
		if (gain <= 0) continue;

		// 9: equivalence of every affected program on its cases: outputs and virtual cost.
		let verifiedCases = 0;
		let equivalent = true;
		for (const entryIndex of byEntry.keys()) {
			const original = corpus[entryIndex];
			const rewrittenProgram = rewritten[entryIndex].program;
			const check = checkProgram(rewrittenProgram, {
				limits: options.limits,
				granted: new Set(original.granted),
				library,
				inputSummary: original.inputBounds,
			});
			if (!check.ok) {
				equivalent = false;
				break;
			}
			const context: EvalContext = { limits: options.limits, library };
			for (const input of original.cases) {
				const host = original.host?.(input);
				const a = execute(original.program, input, context, host);
				const b = execute(rewrittenProgram, input, context, host);
				const same =
					a.ok === b.ok &&
					(a.ok && b.ok
						? canonical(a.value) === canonical(b.value) && a.metrics.units === b.metrics.units
						: !a.ok && !b.ok && a.error.code === b.error.code);
				if (!same) {
					equivalent = false;
					break;
				}
				verifiedCases++;
			}
			if (!equivalent) break;
		}
		if (!equivalent) continue;
		reports.push({
			skill,
			hash,
			occurrences: chosen.length,
			programs: [...new Set(chosen.map((occurrence) => corpus[occurrence.entry].id))],
			corpusNodesBefore: before,
			corpusNodesAfter: after,
			definitionNodes: definition,
			gain,
			verifiedCases,
			rewritten: [...byEntry.keys()].map((index) => rewritten[index]),
		});
	}
	return reports.sort((a, b) => b.gain - a.gain || a.hash.localeCompare(b.hash));
}
