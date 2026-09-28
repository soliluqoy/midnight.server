/**
 * The SQLite surface the store uses, over `node:sqlite` under Node and `bun:sqlite` under Bun.
 *
 * The released `midnight.server` binary is compiled with Bun, which does not provide
 * `node:sqlite`. Both runtimes are loaded through `process.getBuiltinModule`, so neither module is
 * a static import a bundler would try to resolve. Differences smoothed over here: Bun returns
 * `null` for a missing row (Node returns `undefined`), and the read-only option is spelled
 * differently.
 */
export type SqlValue = null | number | bigint | string | Uint8Array;

export interface SqlStatement {
	get(...params: SqlValue[]): unknown;
	all(...params: SqlValue[]): unknown[];
	run(...params: SqlValue[]): { lastInsertRowid: number | bigint; changes: number | bigint };
}

export interface SqlDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqlStatement;
	close(): void;
}

interface NativeStatement {
	/** Bun only: release the statement now instead of at garbage collection. */
	finalize?(): void;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
	run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
}

interface NativeDatabase {
	exec(sql: string): unknown;
	prepare(sql: string): NativeStatement;
	close(): void;
}

type NativeConstructor = new (path: string, options?: Record<string, unknown>) => NativeDatabase;

function getBuiltin(id: string): unknown {
	return (process as unknown as { getBuiltinModule(id: string): unknown }).getBuiltinModule(id);
}

let native: { open: NativeConstructor; readOnly: (readOnly: boolean) => Record<string, unknown> } | undefined;

function runtime(): NonNullable<typeof native> {
	if (native) return native;
	if (typeof process.versions.bun === "string") {
		const { Database } = getBuiltin("bun:sqlite") as { Database: NativeConstructor };
		native = { open: Database, readOnly: (readOnly) => (readOnly ? { readonly: true } : { create: true }) };
	} else {
		const { DatabaseSync } = getBuiltin("node:sqlite") as { DatabaseSync: NativeConstructor };
		native = { open: DatabaseSync, readOnly: (readOnly) => (readOnly ? { readOnly: true } : {}) };
	}
	return native;
}

class Statement implements SqlStatement {
	private readonly inner: NativeStatement;

	constructor(inner: NativeStatement) {
		this.inner = inner;
	}

	get(...params: SqlValue[]): unknown {
		return this.inner.get(...params) ?? undefined;
	}

	all(...params: SqlValue[]): unknown[] {
		return this.inner.all(...params);
	}

	run(...params: SqlValue[]): { lastInsertRowid: number | bigint; changes: number | bigint } {
		const result = this.inner.run(...params);
		return { lastInsertRowid: result.lastInsertRowid, changes: result.changes };
	}
}

/**
 * Statements are cached per SQL text. Besides saving a prepare per query, this lets `close`
 * finalize every statement: Bun otherwise keeps the file open until they are garbage collected,
 * and Windows then refuses to delete or replace the database.
 */
class Database implements SqlDatabase {
	private readonly inner: NativeDatabase;
	private readonly statements = new Map<string, Statement>();
	private readonly natives: NativeStatement[] = [];

	constructor(inner: NativeDatabase) {
		this.inner = inner;
	}

	exec(sql: string): void {
		this.inner.exec(sql);
	}

	prepare(sql: string): SqlStatement {
		let statement = this.statements.get(sql);
		if (!statement) {
			const native = this.inner.prepare(sql);
			this.natives.push(native);
			statement = new Statement(native);
			this.statements.set(sql, statement);
		}
		return statement;
	}

	close(): void {
		for (const native of this.natives) native.finalize?.();
		this.natives.length = 0;
		this.statements.clear();
		this.inner.close();
	}
}

/** Open a database file, or `:memory:`. */
export function openDatabase(path: string, options: { readOnly?: boolean } = {}): SqlDatabase {
	const { open, readOnly } = runtime();
	return new Database(new open(path, readOnly(options.readOnly ?? false)));
}
