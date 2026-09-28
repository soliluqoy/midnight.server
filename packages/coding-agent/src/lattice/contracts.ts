import { canonical, digest, sha256 } from "./canonical.ts";
import { type Expr, IR_VERSION, type Program, T, type Type, type Value } from "./ir.ts";
import { INSTALLATION_LIMITS } from "./limits.ts";
import { type Effect, type Host, LatticeError, type Summary } from "./primitives.ts";
import { PyRandom } from "./random.ts";
import { validateValue } from "./typecheck.ts";

/**
 * Human-owned contracts (spec sections 10.1 and 37.4). The contract fixes the meaning of a task:
 * input schema and bounds, the oracle, postconditions and the fixture families. Candidates can
 * change how a task is computed, never what counts as success. Editing any of this is a new
 * revision, which invalidates earlier claims of equivalence.
 */
export interface Contract {
	id: string;
	revision: number;
	description: string;
	inputType: Type;
	outputType: Type;
	/** Bounds every validated input satisfies; the checker uses them to prove totality. */
	inputBounds: Summary;
	granted: Effect[];
	/** Throws on an input outside the schema or bounds. */
	validateInput(raw: unknown): Value;
	/** The contract's meaning. `host` is the world the case ran against (for `read` effects). */
	oracle(input: Value, host?: Host): Value;
	/** Synthetic world for fixture inputs, for contracts whose programs read through a host. */
	host?(input: Value): Host;
	/** Wall budget for one live task when inputs are large (spec section 42.1); default interactive. */
	budgetMs?: number;
	postconditions: { name: string; check(input: Value, output: Value): boolean }[];
	/** The human-authored seed program, installed as version 1. */
	seed(): Program;
	fixtures: {
		/** Visible to the candidate generator. */
		development(): Value[];
		/** Known edge cases; counterexamples found later are added from the store. */
		regression(): Value[];
		/** Fresh cases for release set `n` (1-based). Each set may be consumed once. */
		release(n: number): Value[];
		/** A shifted distribution for release set `n`; protected against cost regression. */
		shifted(n: number): Value[];
	};
	/** Random small inputs near decision boundaries, for counterexample search. */
	fuzz?(rng: PyRandom): Value;
}

/** Identity of the evaluator: the contract's declared data plus the source of its oracle and checks. */
export function evaluatorHash(contract: Contract): string {
	return digest({
		id: contract.id,
		revision: contract.revision,
		input: contract.inputType,
		output: contract.outputType,
		bounds: contract.inputBounds,
		oracle: contract.oracle.toString(),
		postconditions: contract.postconditions.map((post) => [post.name, post.check.toString()]),
		validate: contract.validateInput.toString(),
	});
}

// Small builders for seed programs.
const v = (name: string): Expr => ({ node: "var", name });
const f = (record: Expr, name: string): Expr => ({ node: "field", record, name });
const s = (value: string): Expr => ({ node: "const", type: T.string, value });
const i = (value: number): Expr => ({ node: "const", type: T.int, value });
const call = (op: string, ...args: Expr[]): Expr => ({ node: "call", op, args });
const and = (...args: Expr[]): Expr => ({ node: "and", args });
const or = (...args: Expr[]): Expr => ({ node: "or", args });

/* ------------------------------------------------------------------------------------------ */
/* records.filter: the reference task (spec section 27) expressed in the IR.                   */
/* ------------------------------------------------------------------------------------------ */

export const RECORD_TYPE = T.record({
	id: T.int,
	text: T.string,
	size: T.int,
	hidden: T.bool,
	ext: T.string,
	age: T.int,
});

const RECORDS_MAX = 4096;
const RECORDS_MAX_TEXT = 256;

/** The five reference predicates, in the reference's baseline order. */
export const RECORD_PREDICATES: { [name: string]: Expr } = {
	text_hit: call("contains", f(v("r"), "text"), s("ERROR")),
	size_positive: call("gt", f(v("r"), "size"), i(0)),
	visible: call("not", f(v("r"), "hidden")),
	is_log: call("eq", f(v("r"), "ext"), s("log")),
	old_enough: call("ge", f(v("r"), "age"), i(14)),
};

export const RECORD_BASELINE = ["text_hit", "size_positive", "visible", "is_log", "old_enough"];

export function recordsFilterProgram(order: readonly string[]): Program {
	return {
		ir_version: IR_VERSION,
		input_type: T.list(RECORD_TYPE),
		output_type: T.list(T.int),
		body: {
			node: "map",
			list: {
				node: "filter",
				list: { node: "input" },
				param: "r",
				body: and(...order.map((name) => RECORD_PREDICATES[name])),
				maxItems: RECORDS_MAX,
			},
			param: "r",
			body: f(v("r"), "id"),
			maxItems: RECORDS_MAX,
		},
	};
}

interface RecordRow {
	id: number;
	text: string;
	size: number;
	hidden: boolean;
	ext: string;
	age: number;
}

/** The reference `fixture` generator, draw for draw. */
export function recordFixture(seed: number, count = 256, logProbability = 0.2): RecordRow[] {
	const rng = new PyRandom(seed);
	const rows: RecordRow[] = [];
	for (let index = 0; index < count; index++) {
		let text = "x".repeat(rng.randint(16, 120));
		if (rng.random() < 0.6) text += "ERROR";
		const size = rng.choice([0, 1, 10, 100]);
		const hidden = rng.random() < 0.15;
		const ext = rng.random() < logProbability ? "log" : "txt";
		const age = rng.randrange(40);
		rows.push({ id: index, text, size, hidden, ext, age });
	}
	return rows;
}

/** The reference `boundary_fixture`: every combination of predicate edge values. */
export function recordBoundaryFixture(): RecordRow[] {
	const rows: RecordRow[] = [];
	let id = 0;
	for (const text of ["", "ERROR", "error"])
		for (const size of [0, 1])
			for (const hidden of [false, true])
				for (const ext of ["log", "LOG"])
					for (const age of [13, 14]) rows.push({ id: id++, text, size, hidden, ext, age });
	return rows;
}

export const recordsFilter: Contract = {
	id: "records.filter",
	revision: 1,
	description: "IDs of records with ERROR in the text, positive size, not hidden, ext log, age >= 14",
	inputType: T.list(RECORD_TYPE),
	outputType: T.list(T.int),
	inputBounds: {
		card: RECORDS_MAX,
		item: {
			fields: {
				id: { mag: 1e9 },
				text: { bytes: RECORDS_MAX_TEXT * 4 },
				size: { mag: 1e9 },
				hidden: {},
				ext: { bytes: 16 * 4 },
				age: { mag: 1e9 },
			},
		},
	},
	granted: [],
	validateInput(raw: unknown): Value {
		const rows = validateValue(T.list(RECORD_TYPE), raw, INSTALLATION_LIMITS) as unknown as RecordRow[];
		if (rows.length > RECORDS_MAX) throw new Error("input must be a bounded array");
		const ids = new Set<number>();
		for (const row of rows) {
			if (ids.has(row.id)) throw new Error("record IDs must be unique integers");
			ids.add(row.id);
			// Lengths in code points, as the reference measures them.
			if ([...row.text].length > RECORDS_MAX_TEXT) throw new Error("text length exceeded");
			if ([...row.ext].length > 16) throw new Error("invalid extension");
			for (const key of ["id", "size", "age"] as const) {
				if (Math.abs(row[key]) > 1e9) throw new Error("size and age must be bounded integers");
			}
		}
		return rows as unknown as Value;
	},
	oracle(input: Value): Value {
		return (input as unknown as RecordRow[])
			.filter((r) => r.size > 0 && !r.hidden && r.ext === "log" && r.age >= 14 && r.text.includes("ERROR"))
			.map((r) => r.id);
	},
	postconditions: [
		{
			name: "ids_are_input_ids_in_order",
			check(input: Value, output: Value): boolean {
				const ids = (input as unknown as RecordRow[]).map((row) => row.id);
				let cursor = 0;
				for (const id of output as number[]) {
					cursor = ids.indexOf(id, cursor);
					if (cursor < 0) return false;
					cursor++;
				}
				return true;
			},
		},
	],
	seed: () => recordsFilterProgram(RECORD_BASELINE),
	fixtures: {
		development: () => Array.from({ length: 16 }, (_, index) => recordFixture(index) as unknown as Value),
		regression: () => [recordBoundaryFixture() as unknown as Value],
		release: (n) =>
			Array.from({ length: 32 }, (_, index) => recordFixture(10_000 + (n - 1) * 32 + index) as unknown as Value),
		shifted: (n) =>
			Array.from(
				{ length: 8 },
				(_, index) => recordFixture(20_000 + (n - 1) * 8 + index, 256, 0.8) as unknown as Value,
			),
	},
	fuzz(rng: PyRandom): Value {
		return Array.from({ length: 24 }, (_, id) => ({
			id,
			text: rng.choice(["", "ERROR", "xERRORx", "error", "xxxx"]),
			size: rng.choice([-1, 0, 1, 5]),
			hidden: rng.random() < 0.5,
			ext: rng.choice(["log", "LOG", "txt", ""]),
			age: rng.choice([0, 13, 14, 15, 39]),
		})) as unknown as Value;
	},
};

/* ------------------------------------------------------------------------------------------ */
/* inventory.report: read-only directory inventory grouped by file category.                  */
/* ------------------------------------------------------------------------------------------ */

export const ENTRY_TYPE = T.record({ path: T.string, size: T.int, hidden: T.bool, kind: T.string });
export const REPORT_ROW_TYPE = T.record({ category: T.string, count: T.int, bytes: T.int });

export const INVENTORY_MAX_ENTRIES = 4096;
const INVENTORY_MAX_PATH = 1024;
const INVENTORY_MAX_SIZE = 1e12;

/** Fixed classification table: part of the contract, not of any candidate. */
export const CATEGORIES: { [category: string]: string[] } = {
	archive: ["zip", "gz"],
	code: ["ts", "js", "py", "rs"],
	data: ["json", "csv", "yaml"],
	docs: ["md", "txt", "pdf"],
	media: ["png", "jpg", "mp4"],
};
export const CATEGORY_NAMES = [...Object.keys(CATEGORIES), "other"].sort();

export function categoryOf(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	const ext = dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
	for (const [category, extensions] of Object.entries(CATEGORIES)) if (extensions.includes(ext)) return category;
	return "other";
}

interface Entry {
	path: string;
	size: number;
	hidden: boolean;
	kind: string;
}

interface ReportRow {
	category: string;
	count: number;
	bytes: number;
}

/** The seed: classify through an if-chain in the fixed table order, twice per category. */
function inventorySeed(): Program {
	const ext = call("ext_of", f(v("e"), "path"));
	let classify: Expr = s("other");
	for (const category of Object.keys(CATEGORIES).reverse()) {
		classify = {
			node: "if",
			cond: or(...CATEGORIES[category].map((extension) => call("eq", v("x"), s(extension)))),
			ifTrue: s(category),
			ifFalse: classify,
		};
	}
	const matching = (): Expr => ({
		node: "filter",
		list: { node: "input" },
		param: "e",
		body: and(
			call("eq", { node: "let", name: "x", value: ext, body: classify }, v("c")),
			call("eq", f(v("e"), "kind"), s("file")),
			call("not", f(v("e"), "hidden")),
		),
		maxItems: INVENTORY_MAX_ENTRIES,
	});
	return {
		ir_version: IR_VERSION,
		input_type: T.list(ENTRY_TYPE),
		output_type: T.list(REPORT_ROW_TYPE),
		body: {
			node: "map",
			list: { node: "const", type: T.list(T.string), value: CATEGORY_NAMES },
			param: "c",
			body: {
				node: "record",
				fields: {
					category: v("c"),
					count: call("length", matching()),
					bytes: call("sum", {
						node: "map",
						list: matching(),
						param: "e",
						body: f(v("e"), "size"),
						maxItems: INVENTORY_MAX_ENTRIES,
					}),
				},
			},
			maxItems: 16,
		},
	};
}

const EXTENSION_POOLS: { [family: string]: [string, number][] } = {
	// Source-heavy trees, like a code checkout.
	source: [
		["ts", 40],
		["md", 10],
		["json", 10],
		["js", 8],
		["png", 4],
		["", 6],
		["lock", 4],
		["yaml", 3],
		["txt", 3],
		["gz", 1],
		["TS", 1],
	],
	// Media-heavy trees, like a downloads folder.
	media: [
		["jpg", 30],
		["png", 20],
		["mp4", 15],
		["pdf", 10],
		["zip", 8],
		["txt", 5],
		["", 5],
		["ts", 2],
		["exe", 5],
	],
};

export function inventoryFixture(seed: number, family: keyof typeof EXTENSION_POOLS, count = 400): Entry[] {
	const rng = new PyRandom(seed);
	const pool = EXTENSION_POOLS[family];
	const total = pool.reduce((sum, [, weight]) => sum + weight, 0);
	const pick = () => {
		let roll = rng.below(total);
		for (const [extension, weight] of pool) {
			if (roll < weight) return extension;
			roll -= weight;
		}
		return "";
	};
	const entries: Entry[] = [];
	const dirs = ["src", "docs", "assets", "build", ".cache", "test", "src/lib"];
	for (let index = 0; index < count; index++) {
		const dir = rng.choice(dirs);
		if (rng.random() < 0.08) {
			entries.push({ path: `${dir}/sub${index}`, size: 0, hidden: dir.startsWith("."), kind: "dir" });
			continue;
		}
		const extension = pick();
		const dotfile = rng.random() < 0.05;
		const stem = dotfile ? `.f${index}` : `f${index}`;
		const path = `${dir}/${stem}${extension ? `.${extension}` : ""}`;
		entries.push({
			path,
			size: rng.randint(0, 50_000),
			hidden: dotfile || dir.startsWith("."),
			kind: "file",
		});
	}
	return entries;
}

function inventoryEdgeCases(): Entry[][] {
	return [
		[],
		[
			{ path: "a", size: 1, hidden: false, kind: "file" },
			{ path: ".gitignore", size: 2, hidden: true, kind: "file" },
			{ path: "x/.env.json", size: 3, hidden: true, kind: "file" },
			{ path: "A.TS", size: 4, hidden: false, kind: "file" },
			{ path: "b.tar.gz", size: 5, hidden: false, kind: "file" },
			{ path: "dir.ts", size: 0, hidden: false, kind: "dir" },
			{ path: "ünïcode/ファイル.md", size: 6, hidden: false, kind: "file" },
			{ path: "trailing.", size: 7, hidden: false, kind: "file" },
			{ path: "a.b/c", size: 8, hidden: false, kind: "file" },
			{ path: "big.mp4", size: 999_999_999_999, hidden: false, kind: "file" },
		],
	];
}

export const inventoryReport: Contract = {
	id: "inventory.report",
	revision: 1,
	description: "Count and total size of visible files per category, for every category, sorted by category",
	inputType: T.list(ENTRY_TYPE),
	outputType: T.list(REPORT_ROW_TYPE),
	inputBounds: {
		card: INVENTORY_MAX_ENTRIES,
		item: {
			fields: {
				path: { bytes: INVENTORY_MAX_PATH },
				size: { mag: INVENTORY_MAX_SIZE },
				hidden: {},
				kind: { bytes: 4 },
			},
		},
	},
	granted: [],
	validateInput(raw: unknown): Value {
		const entries = validateValue(T.list(ENTRY_TYPE), raw, INSTALLATION_LIMITS) as unknown as Entry[];
		if (entries.length > INVENTORY_MAX_ENTRIES) throw new Error(`snapshot exceeds ${INVENTORY_MAX_ENTRIES} entries`);
		const paths = new Set<string>();
		for (const entry of entries) {
			if (paths.has(entry.path)) throw new Error("duplicate path in snapshot");
			paths.add(entry.path);
			if (Buffer.byteLength(entry.path) > INVENTORY_MAX_PATH) throw new Error("path too long");
			if (entry.size < 0 || entry.size > INVENTORY_MAX_SIZE) throw new Error("size out of range");
			if (entry.kind !== "file" && entry.kind !== "dir") throw new Error("kind must be file or dir");
		}
		return entries as unknown as Value;
	},
	oracle(input: Value): Value {
		const rows = new Map(CATEGORY_NAMES.map((category) => [category, { category, count: 0, bytes: 0 }]));
		for (const entry of input as unknown as Entry[]) {
			if (entry.kind !== "file" || entry.hidden) continue;
			const row = rows.get(categoryOf(entry.path))!;
			row.count++;
			row.bytes += entry.size;
		}
		return CATEGORY_NAMES.map((category) => rows.get(category)!) as unknown as Value;
	},
	postconditions: [
		{
			name: "report_schema_v1",
			check: (_input, output) =>
				Array.isArray(output) &&
				canonical((output as unknown as ReportRow[]).map((row) => row.category)) === canonical(CATEGORY_NAMES),
		},
		{
			name: "all_snapshot_entries_accounted_for",
			check: (input, output) =>
				(output as unknown as ReportRow[]).reduce((sum, row) => sum + row.count, 0) ===
				(input as unknown as Entry[]).filter((entry) => entry.kind === "file" && !entry.hidden).length,
		},
		{
			name: "bytes_accounted_for",
			check: (input, output) =>
				(output as unknown as ReportRow[]).reduce((sum, row) => sum + row.bytes, 0) ===
				(input as unknown as Entry[])
					.filter((entry) => entry.kind === "file" && !entry.hidden)
					.reduce((sum, entry) => sum + entry.size, 0),
		},
	],
	seed: inventorySeed,
	fixtures: {
		development: () =>
			Array.from({ length: 8 }, (_, index) => inventoryFixture(index, "source", 250) as unknown as Value),
		regression: () => inventoryEdgeCases() as unknown as Value[],
		release: (n) =>
			Array.from(
				{ length: 32 },
				(_, index) => inventoryFixture(10_000 + (n - 1) * 32 + index, "source") as unknown as Value,
			),
		shifted: (n) =>
			Array.from(
				{ length: 8 },
				(_, index) => inventoryFixture(20_000 + (n - 1) * 8 + index, "media") as unknown as Value,
			),
	},
	fuzz(rng: PyRandom): Value {
		const names = ["a.ts", "b.TS", ".c.md", "d", "e.tar.gz", "f.", "g.json", "h.mp4", "i.exe", "j.zip"];
		return Array.from({ length: 24 }, (_, index) => ({
			path: `${rng.choice(["", "x/", ".y/"])}${index}${rng.choice(names)}`,
			size: rng.choice([0, 1, 1000]),
			hidden: rng.random() < 0.3,
			kind: rng.random() < 0.2 ? "dir" : "file",
		})) as unknown as Value;
	},
};

/* ------------------------------------------------------------------------------------------ */
/* organize.plan: effect intents that move top-level files into category directories.          */
/* ------------------------------------------------------------------------------------------ */

export const MOVE_TYPE = T.record({ from: T.string, to: T.string });

/** `let x = ext_of(record.path) in if-chain` over the fixed classification table. */
export function classifyExpr(record: Expr): Expr {
	let chain: Expr = s("other");
	for (const category of Object.keys(CATEGORIES).reverse()) {
		chain = {
			node: "if",
			cond: or(...CATEGORIES[category].map((extension) => call("eq", v("x"), s(extension)))),
			ifTrue: s(category),
			ifFalse: chain,
		};
	}
	return { node: "let", name: "x", value: call("ext_of", f(record, "path")), body: chain };
}

interface Move {
	from: string;
	to: string;
}

/**
 * The seed is correct and deliberately naive: inside the per-file filter it rebuilds the list of
 * all paths (quadratic work) and classifies each file three times.
 */
function organizeSeed(): Program {
	const e = v("e");
	const destination = (): Expr => call("concat", call("concat", classifyExpr(e), s("/")), f(e, "path"));
	const allPaths = (): Expr => ({
		node: "map",
		list: { node: "input" },
		param: "p",
		body: f(v("p"), "path"),
		maxItems: INVENTORY_MAX_ENTRIES,
	});
	const filePaths = (): Expr => ({
		node: "map",
		list: {
			node: "filter",
			list: { node: "input" },
			param: "q",
			body: call("eq", f(v("q"), "kind"), s("file")),
			maxItems: INVENTORY_MAX_ENTRIES,
		},
		param: "p",
		body: f(v("p"), "path"),
		maxItems: INVENTORY_MAX_ENTRIES,
	});
	return {
		ir_version: IR_VERSION,
		input_type: T.list(ENTRY_TYPE),
		output_type: T.list(MOVE_TYPE),
		body: {
			node: "map",
			list: {
				node: "filter",
				list: { node: "input" },
				param: "e",
				body: and(
					call("eq", f(e, "kind"), s("file")),
					call("not", f(e, "hidden")),
					call("not", call("contains", f(e, "path"), s("/"))),
					call("ne", classifyExpr(e), s("other")),
					call("not", call("in_list", allPaths(), destination())),
					call("not", call("in_list", filePaths(), classifyExpr(e))),
				),
				maxItems: INVENTORY_MAX_ENTRIES,
			},
			param: "e",
			body: { node: "record", fields: { from: f(e, "path"), to: destination() } },
			maxItems: INVENTORY_MAX_ENTRIES,
		},
	};
}

export function organizeFixture(seed: number, count = 160): Entry[] {
	const rng = new PyRandom(seed);
	const extensions = ["ts", "md", "json", "png", "zip", "txt", "", "exe", "js", "jpg"];
	const entries = new Map<string, Entry>();
	const add = (entry: Entry) => entries.set(entry.path, entry);
	for (let index = 0; index < count; index++) {
		const extension = rng.choice(extensions);
		const name = `f${index}${extension ? `.${extension}` : ""}`;
		const roll = rng.random();
		if (roll < 0.1) add({ path: `.${name}`, size: rng.randint(0, 999), hidden: true, kind: "file" });
		else if (roll < 0.25) add({ path: `nested/${name}`, size: rng.randint(0, 999), hidden: false, kind: "file" });
		else add({ path: name, size: rng.randint(0, 999), hidden: false, kind: "file" });
	}
	// Existing category folders, a collision inside one, and a file squatting on a category name.
	add({ path: "nested", size: 0, hidden: false, kind: "dir" });
	add({ path: "code", size: 0, hidden: false, kind: "dir" });
	const first = [...entries.values()].find((entry) => entry.path.endsWith(".ts") && !entry.path.includes("/"));
	if (first) add({ path: `code/${first.path}`, size: 1, hidden: false, kind: "file" });
	if (rng.random() < 0.5) add({ path: "media", size: 3, hidden: false, kind: "file" });
	return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const organizePlan: Contract = {
	id: "organize.plan",
	revision: 1,
	description:
		"Move every visible top-level file into <category>/<name>, except category other, taken destinations and categories blocked by a file",
	inputType: T.list(ENTRY_TYPE),
	outputType: T.list(MOVE_TYPE),
	inputBounds: inventoryReport.inputBounds,
	granted: [],
	validateInput: (raw: unknown) => inventoryReport.validateInput(raw),
	oracle(input: Value): Value {
		const entries = input as unknown as Entry[];
		const paths = new Set(entries.map((entry) => entry.path));
		const files = new Set(entries.filter((entry) => entry.kind === "file").map((entry) => entry.path));
		const moves: Move[] = [];
		for (const entry of entries) {
			if (entry.kind !== "file" || entry.hidden || entry.path.includes("/")) continue;
			const category = categoryOf(entry.path);
			const to = `${category}/${entry.path}`;
			if (category === "other" || paths.has(to) || files.has(category)) continue;
			moves.push({ from: entry.path, to });
		}
		return moves as unknown as Value;
	},
	postconditions: [
		{
			name: "destinations_unique",
			check: (_input, output) => {
				const moves = output as unknown as Move[];
				return new Set(moves.map((move) => move.to)).size === moves.length;
			},
		},
		{
			name: "sources_are_visible_top_level_files",
			check: (input, output) => {
				const files = new Set(
					(input as unknown as Entry[])
						.filter((entry) => entry.kind === "file" && !entry.hidden && !entry.path.includes("/"))
						.map((entry) => entry.path),
				);
				return (output as unknown as Move[]).every((move) => files.has(move.from));
			},
		},
		{
			name: "destinations_absent_and_categorized",
			check: (input, output) => {
				const paths = new Set((input as unknown as Entry[]).map((entry) => entry.path));
				return (output as unknown as Move[]).every(
					(move) =>
						!paths.has(move.to) &&
						categoryOf(move.from) !== "other" &&
						move.to === `${categoryOf(move.from)}/${move.from}`,
				);
			},
		},
	],
	seed: organizeSeed,
	fixtures: {
		development: () => Array.from({ length: 6 }, (_, index) => organizeFixture(index) as unknown as Value),
		regression: () =>
			[
				[],
				[
					{ path: "a.ts", size: 1, hidden: false, kind: "file" },
					{ path: "code", size: 3, hidden: false, kind: "file" },
					{ path: "b.md", size: 1, hidden: false, kind: "file" },
					{ path: "docs", size: 0, hidden: false, kind: "dir" },
					{ path: "docs/b.md", size: 1, hidden: false, kind: "file" },
					{ path: ".c.png", size: 1, hidden: true, kind: "file" },
					{ path: "d.PNG", size: 1, hidden: false, kind: "file" },
					{ path: "e", size: 1, hidden: false, kind: "file" },
					// A directory whose name looks like a file must never be moved.
					{ path: "photos.png", size: 0, hidden: false, kind: "dir" },
					{ path: "photos.png/1.jpg", size: 1, hidden: false, kind: "file" },
				],
			] as unknown as Value[],
		release: (n) =>
			Array.from({ length: 32 }, (_, index) => organizeFixture(10_000 + (n - 1) * 32 + index) as unknown as Value),
		shifted: (n) =>
			Array.from(
				{ length: 8 },
				(_, index) => organizeFixture(20_000 + (n - 1) * 8 + index, 400) as unknown as Value,
			),
	},
	fuzz(rng: PyRandom): Value {
		const names = ["a.ts", "b.md", "c.png", "d", "e.zip", "code", "docs", "f.json"];
		const entries = new Map<string, Entry>();
		for (let i = 0; i < 16; i++) {
			const name = rng.choice(names);
			const path = rng.random() < 0.3 ? `${rng.choice(["code", "docs", "media"])}/${name}` : name;
			entries.set(path, { path, size: 1, hidden: rng.random() < 0.2, kind: rng.random() < 0.15 ? "dir" : "file" });
		}
		return [...entries.values()] as unknown as Value;
	},
};

/* ------------------------------------------------------------------------------------------ */
/* duplicates.report: files whose content appears more than once (a `read` effect contract).  */
/* ------------------------------------------------------------------------------------------ */

export const DUPLICATE_TYPE = T.record({ path: T.string, copies: T.int });

interface Duplicate {
	path: string;
	copies: number;
}

/**
 * The synthetic world behind fixture inputs: a `~gN` marker in a file name puts it in content
 * group N, every other file has its own content, and all empty files are equal (as on disk).
 * Programs cannot see contents; they must read through `content_hash`, and the oracle uses the
 * same host, so the naming is only this world's storage scheme.
 */
export function syntheticContentHost(input: Value): Host {
	const entries = new Map((input as unknown as Entry[]).map((entry) => [entry.path, entry]));
	return {
		contentHash(ref: string, size: number): string {
			const entry = entries.get(ref);
			if (!entry || entry.kind !== "file") throw new LatticeError("host", "file not found");
			// The real broker refuses a file whose byte count differs from the observed size; so does this one.
			if (entry.size !== size) throw new LatticeError("host", "unstable input: size differs from the snapshot");
			const group = /~g(\d+)/.exec(ref.slice(ref.lastIndexOf("/") + 1));
			const content = size === 0 ? "empty" : group ? `group:${group[1]}` : `unique:${ref}`;
			return sha256(`${content}\0${size}`);
		},
	};
}

/** Seed: correct, and hashes both files of every pair, twice (quadratic reads). */
function duplicatesSeed(): Program {
	const sameContent = (): Expr =>
		call(
			"eq",
			call("content_hash", f(v("g"), "path"), f(v("g"), "size")),
			call("content_hash", f(v("f"), "path"), f(v("f"), "size")),
		);
	const copies = (): Expr =>
		call("length", {
			node: "filter",
			list: v("files"),
			param: "g",
			body: sameContent(),
			maxItems: INVENTORY_MAX_ENTRIES,
		});
	return {
		ir_version: IR_VERSION,
		input_type: T.list(ENTRY_TYPE),
		output_type: T.list(DUPLICATE_TYPE),
		body: {
			node: "let",
			name: "files",
			value: {
				node: "filter",
				list: { node: "input" },
				param: "e",
				body: and(call("eq", f(v("e"), "kind"), s("file")), call("not", f(v("e"), "hidden"))),
				maxItems: INVENTORY_MAX_ENTRIES,
			},
			body: {
				node: "map",
				list: {
					node: "filter",
					list: v("files"),
					param: "f",
					body: call("gt", copies(), i(1)),
					maxItems: INVENTORY_MAX_ENTRIES,
				},
				param: "f",
				body: { node: "record", fields: { path: f(v("f"), "path"), copies: copies() } },
				maxItems: INVENTORY_MAX_ENTRIES,
			},
		},
	};
}

export function duplicatesFixture(
	seed: number,
	count = 100,
	options: { maxSize?: number; groups?: number } = {},
): Entry[] {
	const rng = new PyRandom(seed);
	const maxSize = options.maxSize ?? 20_000;
	const dirs = ["photos", "docs", "backup", "misc"];
	const entries = new Map<string, Entry>();
	const add = (entry: Entry) => entries.set(entry.path, entry);
	for (const dir of dirs) add({ path: dir, size: 0, hidden: false, kind: "dir" });
	add({ path: ".cache", size: 0, hidden: true, kind: "dir" });
	for (let index = 0; index < count; index++) {
		const dir = rng.choice(dirs);
		const hidden = rng.random() < 0.05;
		add({ path: `${dir}/${hidden ? "." : ""}f${index}.bin`, size: rng.randint(1, maxSize), hidden, kind: "file" });
	}
	const groups = options.groups ?? Math.max(1, Math.round(count / 12));
	for (let group = 0; group < groups; group++) {
		const size = rng.randint(1, maxSize);
		const members = 2 + rng.below(3);
		for (let member = 0; member < members; member++) {
			const hidden = rng.random() < 0.1;
			add({
				path: `${rng.choice(dirs)}/${hidden ? "." : ""}copy${group}_${member}~g${group}.bin`,
				size,
				hidden,
				kind: "file",
			});
		}
		// A decoy: same size, different content.
		add({ path: `${rng.choice(dirs)}/decoy${group}.bin`, size, hidden: false, kind: "file" });
	}
	if (rng.random() < 0.5) {
		add({ path: "misc/empty-a.txt", size: 0, hidden: false, kind: "file" });
		add({ path: "docs/empty-b.txt", size: 0, hidden: false, kind: "file" });
	}
	return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const duplicatesReport: Contract = {
	id: "duplicates.report",
	revision: 1,
	description: "Visible files whose content appears more than once among visible files, with the number of copies",
	inputType: T.list(ENTRY_TYPE),
	outputType: T.list(DUPLICATE_TYPE),
	inputBounds: inventoryReport.inputBounds,
	granted: ["read"],
	budgetMs: 60_000,
	validateInput: (raw: unknown) => inventoryReport.validateInput(raw),
	host: syntheticContentHost,
	oracle(input: Value, host?: Host): Value {
		const world = host ?? syntheticContentHost(input);
		const files = (input as unknown as Entry[]).filter((entry) => entry.kind === "file" && !entry.hidden);
		const hashes = files.map((file) => world.contentHash!(file.path, file.size));
		const counts = new Map<string, number>();
		for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);
		return files
			.map((file, index) => ({ path: file.path, copies: counts.get(hashes[index])! }))
			.filter((row) => row.copies >= 2) as unknown as Value;
	},
	postconditions: [
		{
			name: "copies_at_least_two",
			check: (_input, output) => (output as unknown as Duplicate[]).every((row) => row.copies >= 2),
		},
		{
			name: "paths_are_visible_files",
			check: (input, output) => {
				const files = new Set(
					(input as unknown as Entry[])
						.filter((entry) => entry.kind === "file" && !entry.hidden)
						.map((entry) => entry.path),
				);
				return (output as unknown as Duplicate[]).every((row) => files.has(row.path));
			},
		},
		{
			// Independent of hashing: identical files have identical sizes.
			name: "copies_bounded_by_same_size_files",
			check: (input, output) => {
				const sizes = new Map<number, number>();
				const byPath = new Map<string, number>();
				for (const entry of input as unknown as Entry[]) {
					if (entry.kind !== "file" || entry.hidden) continue;
					sizes.set(entry.size, (sizes.get(entry.size) ?? 0) + 1);
					byPath.set(entry.path, entry.size);
				}
				return (output as unknown as Duplicate[]).every(
					(row) => row.copies <= (sizes.get(byPath.get(row.path)!) ?? 0),
				);
			},
		},
	],
	seed: duplicatesSeed,
	fixtures: {
		development: () => Array.from({ length: 6 }, (_, index) => duplicatesFixture(index) as unknown as Value),
		regression: () =>
			[
				[],
				[
					{ path: "a.bin", size: 5, hidden: false, kind: "file" },
					{ path: "b.bin", size: 5, hidden: false, kind: "file" },
					{ path: "c~g1.bin", size: 7, hidden: false, kind: "file" },
					{ path: "d~g1.bin", size: 7, hidden: false, kind: "file" },
					{ path: ".e~g1.bin", size: 7, hidden: true, kind: "file" },
					{ path: "f~g2.bin", size: 9, hidden: false, kind: "file" },
					{ path: "g~g2.bin", size: 9, hidden: false, kind: "file" },
					{ path: "h~g2.bin", size: 9, hidden: false, kind: "file" },
					{ path: "x.txt", size: 0, hidden: false, kind: "file" },
					{ path: "y.txt", size: 0, hidden: false, kind: "file" },
					{ path: "z~g3.bin", size: 4, hidden: false, kind: "file" },
					{ path: "dir~g3.bin", size: 0, hidden: false, kind: "dir" },
				],
			] as unknown as Value[],
		release: (n) =>
			Array.from({ length: 32 }, (_, index) => duplicatesFixture(10_000 + (n - 1) * 32 + index) as unknown as Value),
		// Many size collisions: the protected group where a size prefilter helps least.
		shifted: (n) =>
			Array.from(
				{ length: 8 },
				(_, index) =>
					duplicatesFixture(20_000 + (n - 1) * 8 + index, 100, { maxSize: 40, groups: 12 }) as unknown as Value,
			),
	},
	fuzz(rng: PyRandom): Value {
		const entries = new Map<string, Entry>();
		for (let i = 0; i < 14; i++) {
			const group = rng.below(4);
			const size = rng.choice([0, 1, 2, 3]);
			const path = rng.random() < 0.5 ? `f${i}~g${group}.bin` : `f${i}.bin`;
			entries.set(path, { path, size, hidden: rng.random() < 0.15, kind: rng.random() < 0.1 ? "dir" : "file" });
		}
		return [...entries.values()] as unknown as Value;
	},
};

export const CONTRACTS: ReadonlyMap<string, Contract> = new Map(
	[recordsFilter, inventoryReport, organizePlan, duplicatesReport].map((contract) => [contract.id, contract]),
);

export function getContract(id: string): Contract {
	const contract = CONTRACTS.get(id);
	if (!contract) throw new Error(`unknown contract ${id} (known: ${[...CONTRACTS.keys()].join(", ")})`);
	return contract;
}
