import { digest } from "./canonical.ts";
import { T, type Type, type Value } from "./ir.ts";

/** Side-effect classes (spec section 8.4). The planner cannot compose a program whose effects exceed its grant. */
export type Effect = "pure" | "read" | "write" | "external" | "privileged";

/** Typed runtime failure. `code` is the error class the differential and release checks compare. */
export class LatticeError extends Error {
	readonly code: "type" | "fuel" | "steps" | "bound" | "overflow" | "effect" | "host" | "invalid" | "deadline";

	constructor(code: LatticeError["code"], message: string) {
		super(message);
		this.code = code;
	}
}

/**
 * Static upper bounds for an expression (the `upper_bound_summary` of spec section 39.3).
 * `card`: maximum list length; `mag`: maximum absolute integer; `bytes`: maximum string bytes.
 * An absent field means "unknown", which makes dependent operations non-total.
 */
export interface Summary {
	card?: number;
	mag?: number;
	bytes?: number;
	item?: Summary;
	fields?: { [name: string]: Summary };
}

export const MAX_INT = Number.MAX_SAFE_INTEGER;

/** Host functions a primitive may use. Only the broker supplies them, bound to a capability. */
export interface Host {
	readText?(ref: string, maxBytes: number): string;
	/**
	 * SHA-256 of the file's bytes. Must fail unless the file has exactly `size` bytes and stayed
	 * the same while it was read: `content_hash` declares that equal results imply equal sizes.
	 */
	contentHash?(ref: string, size: number): string;
}

export interface Primitive {
	id: string;
	/** Bumped whenever behavior or cost changes; part of the primitive-library hash. */
	version: number;
	effect: Effect;
	/** Result type for argument types, or an error message. */
	signature(args: readonly Type[]): Type | string;
	/** Can this call fail for arguments within these bounds? Total calls may be reordered and hoisted. */
	total(args: readonly Summary[]): boolean;
	summarize(args: readonly Summary[]): Summary;
	/** Declared virtual cost, charged before the implementation runs (spec section 39.5). */
	cost(args: readonly Value[]): number;
	impl(args: readonly Value[], host: Host): Value;
	/**
	 * Argument positions whose equality is implied by equal results, guaranteed by the kernel's
	 * implementation (and its hosts). `insert_implied_guard` may test those arguments first.
	 */
	equalityImplies?: number[];
}

export const READ_TEXT_MAX_BYTES = 65_536;

const utf8 = (text: string) => Buffer.byteLength(text, "utf8");
const isScalar = (type: Type) => type.kind === "bool" || type.kind === "int" || type.kind === "string";
const same = (a: Type, b: Type) => a.kind === b.kind && isScalar(a);

function checkedInt(value: number): number {
	if (!Number.isSafeInteger(value)) throw new LatticeError("overflow", "integer overflow");
	return value;
}

function magnitudeTotal(mag: number | undefined): boolean {
	return mag !== undefined && mag <= MAX_INT;
}

function unary(
	id: string,
	arg: Type,
	result: Type,
	impl: (value: Value) => Value,
	cost?: (value: Value) => number,
): Primitive {
	return {
		id,
		version: 1,
		effect: "pure",
		signature: (args) =>
			args.length === 1 && args[0].kind === arg.kind ? result : `${id} expects one ${arg.kind} argument`,
		total: () => true,
		summarize: (args) => (result.kind === "string" ? { bytes: args[0]?.bytes } : {}),
		cost: (args) => (cost ? cost(args[0]) : 1),
		impl: (args) => impl(args[0]),
	};
}

function comparison(
	id: string,
	test: (a: number | string, b: number | string) => boolean,
	ordered: boolean,
): Primitive {
	return {
		id,
		version: 1,
		effect: "pure",
		signature: (args) => {
			if (args.length !== 2 || !same(args[0], args[1])) return `${id} expects two scalars of the same type`;
			if (ordered && args[0].kind === "bool") return `${id} expects Int or String`;
			return T.bool;
		},
		total: () => true,
		summarize: () => ({}),
		cost: () => 1,
		impl: (args) => test(args[0] as number | string, args[1] as number | string),
	};
}

function stringTest(id: string, test: (haystack: string, needle: string) => boolean): Primitive {
	return {
		id,
		version: 1,
		effect: "pure",
		signature: (args) =>
			args.length === 2 && args[0].kind === "string" && args[1].kind === "string"
				? T.bool
				: `${id} expects (String, String)`,
		total: () => true,
		summarize: () => ({}),
		// Proportional to the scanned text, like `text_hit` in the reference.
		cost: (args) => Math.max(1, utf8(args[0] as string)),
		impl: (args) => test(args[0] as string, args[1] as string),
	};
}

function arithmetic(
	id: string,
	op: (a: number, b: number) => number,
	mag: (a: number, b: number) => number,
): Primitive {
	return {
		id,
		version: 1,
		effect: "pure",
		signature: (args) =>
			args.length === 2 && args[0].kind === "int" && args[1].kind === "int" ? T.int : `${id} expects (Int, Int)`,
		total: (args) =>
			args[0]?.mag !== undefined && args[1]?.mag !== undefined && magnitudeTotal(mag(args[0].mag, args[1].mag)),
		summarize: (args) =>
			args[0]?.mag !== undefined && args[1]?.mag !== undefined ? { mag: mag(args[0].mag, args[1].mag) } : {},
		cost: () => 1,
		impl: (args) => checkedInt(op(args[0] as number, args[1] as number)),
	};
}

function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

const PRIMITIVE_LIST: Primitive[] = [
	unary("not", T.bool, T.bool, (value) => !value),
	comparison("eq", (a, b) => a === b, false),
	comparison("ne", (a, b) => a !== b, false),
	comparison("lt", (a, b) => a < b, true),
	comparison("le", (a, b) => a <= b, true),
	comparison("gt", (a, b) => a > b, true),
	comparison("ge", (a, b) => a >= b, true),
	arithmetic(
		"add",
		(a, b) => a + b,
		(a, b) => a + b,
	),
	arithmetic(
		"sub",
		(a, b) => a - b,
		(a, b) => a + b,
	),
	arithmetic(
		"mul",
		(a, b) => a * b,
		(a, b) => a * b,
	),
	stringTest("contains", (haystack, needle) => haystack.includes(needle)),
	stringTest("starts_with", (haystack, needle) => haystack.startsWith(needle)),
	stringTest("ends_with", (haystack, needle) => haystack.endsWith(needle)),
	unary(
		"lower",
		T.string,
		T.string,
		(value) => (value as string).toLowerCase(),
		(value) => Math.max(1, utf8(value as string)),
	),
	{
		...unary(
			"str_len",
			T.string,
			T.int,
			(value) => utf8(value as string),
			() => 1,
		),
		summarize: (args) => (args[0]?.bytes !== undefined ? { mag: args[0].bytes } : {}),
	},
	{
		...unary(
			"ext_of",
			T.string,
			T.string,
			(value) => extensionOf(value as string),
			(value) => Math.max(1, utf8(value as string)),
		),
		summarize: (args) => ({ bytes: args[0]?.bytes }),
	},
	{
		id: "concat",
		version: 1,
		effect: "pure",
		signature: (args) =>
			args.length === 2 && args[0].kind === "string" && args[1].kind === "string"
				? T.string
				: "concat expects (String, String)",
		total: () => true,
		summarize: (args) =>
			args[0]?.bytes !== undefined && args[1]?.bytes !== undefined ? { bytes: args[0].bytes + args[1].bytes } : {},
		cost: (args) => 1 + utf8(args[0] as string) + utf8(args[1] as string),
		impl: (args) => (args[0] as string) + (args[1] as string),
	},
	{
		id: "length",
		version: 1,
		effect: "pure",
		signature: (args) => (args.length === 1 && args[0].kind === "list" ? T.int : "length expects a List"),
		total: () => true,
		summarize: (args) => (args[0]?.card !== undefined ? { mag: args[0].card } : {}),
		cost: () => 1,
		impl: (args) => (args[0] as Value[]).length,
	},
	{
		id: "sum",
		version: 1,
		effect: "pure",
		signature: (args) =>
			args.length === 1 && args[0].kind === "list" && args[0].item.kind === "int" ? T.int : "sum expects List<Int>",
		total: (args) =>
			args[0]?.card !== undefined &&
			args[0].item?.mag !== undefined &&
			magnitudeTotal(args[0].card * args[0].item.mag),
		summarize: (args) =>
			args[0]?.card !== undefined && args[0].item?.mag !== undefined ? { mag: args[0].card * args[0].item.mag } : {},
		cost: (args) => 1 + (args[0] as Value[]).length,
		impl: (args) => (args[0] as number[]).reduce((total, value) => checkedInt(total + value), 0),
	},
	{
		id: "in_list",
		version: 1,
		effect: "pure",
		signature: (args) =>
			args.length === 2 && args[0].kind === "list" && isScalar(args[0].item) && args[0].item.kind === args[1].kind
				? T.bool
				: "in_list expects (List<T>, T) for a scalar T",
		total: () => true,
		summarize: () => ({}),
		// A linear scan: charged per element, so repeating it inside a loop is visibly expensive.
		cost: (args) => 1 + (args[0] as Value[]).length,
		impl: (args) => (args[0] as Value[]).includes(args[1]),
	},
	{
		id: "content_hash",
		version: 1,
		effect: "read",
		signature: (args) =>
			args.length === 2 && args[0].kind === "string" && args[1].kind === "int"
				? T.string
				: "content_hash expects (String path, Int size)",
		total: () => false,
		summarize: () => ({ bytes: 64 }),
		// Charged before reading: proportional to the declared size, which the host enforces.
		cost: (args) => 1 + Math.ceil(Math.max(0, args[1] as number) / 64),
		impl: (args, host) => {
			if (!host.contentHash) throw new LatticeError("effect", "content_hash needs a read capability");
			return host.contentHash(args[0] as string, args[1] as number);
		},
		// Equal SHA-256 digests mean equal bytes; the host returns only when the file has `size` bytes.
		equalityImplies: [1],
	},
	{
		id: "read_text",
		version: 1,
		effect: "read",
		signature: (args) =>
			args.length === 1 && args[0].kind === "string" ? T.string : "read_text expects a String ref",
		total: () => false,
		summarize: () => ({ bytes: READ_TEXT_MAX_BYTES }),
		cost: () => 1 + READ_TEXT_MAX_BYTES / 64,
		impl: (args, host) => {
			if (!host.readText) throw new LatticeError("effect", "read_text needs a read capability");
			return host.readText(args[0] as string, READ_TEXT_MAX_BYTES);
		},
	},
];

export const PRIMITIVES: ReadonlyMap<string, Primitive> = new Map(
	PRIMITIVE_LIST.map((primitive) => [primitive.id, primitive]),
);

/** Identity of the primitive set: ids, versions and effect classes. Recorded in every program hash. */
export const PRIMITIVE_LIBRARY_HASH = digest(
	PRIMITIVE_LIST.map((primitive) => [
		primitive.id,
		primitive.version,
		primitive.effect,
		primitive.equalityImplies ?? [],
	]),
);
