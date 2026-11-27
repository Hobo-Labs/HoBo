/**
 * Node.js node:sqlite DatabaseSync adapter.
 * Production callers should use this only behind a serialized storage worker.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	SqliteDriver,
	SqliteRow,
	SqliteRunResult,
	SqliteStatement,
	SqliteValue,
} from "./driver.js";
import { isJsonBigInt, isJsonNumber, isJsonString } from "./json.js";
import { NATIVE_PRAGMAS } from "./schema.js";

export interface NodeSqliteDriverOptions {
	readonly path: string;
	/** Disable extension loading (default true). */
	readonly disableExtensions?: boolean;
}

interface DatabaseSyncOpenOptions {
	readonly readBigInts?: boolean;
}

interface LoadExtensionHost {
	enableLoadExtension?: (enabled: boolean) => void;
}

interface SqliteNativeRunResult {
	changes: number | bigint;
	lastInsertRowid: number | bigint;
}

type NativeBindValue = Exclude<SqliteValue, boolean>;

export function createNodeSqliteDriver(
	options: NodeSqliteDriverOptions,
): SqliteDriver {
	const path = options.path;
	mkdirSync(dirname(path), { recursive: true });
	const openOptions: DatabaseSyncOpenOptions = { readBigInts: true };
	const db = new DatabaseSync(path, openOptions);
	try {
		const main = db
			.prepare("PRAGMA database_list")
			.all()
			.find((entry) => entry.name === "main");
		if (!isJsonString(main?.file) || main.file.length === 0)
			throw new TypeError(
				"native SQLite driver requires a persistent file; use the memory driver for ephemeral storage",
			);
		disableExtensions(db, options.disableExtensions);
		applyNodePragmas(db);
		return wrapDatabaseSync(db, "node");
	} catch (error) {
		db.close();
		throw error;
	}
}

export function createMemoryNodeSqliteDriver(
	options: { readonly disableExtensions?: boolean } = {},
): SqliteDriver {
	const openOptions: DatabaseSyncOpenOptions = { readBigInts: true };
	const db = new DatabaseSync(":memory:", openOptions);
	disableExtensions(db, options.disableExtensions);
	applyNodePragmas(db);
	return wrapDatabaseSync(db, "memory");
}

function applyNodePragmas(db: DatabaseSync): void {
	db.exec(`PRAGMA journal_mode = ${NATIVE_PRAGMAS.journal_mode}`);
	db.exec(`PRAGMA synchronous = ${NATIVE_PRAGMAS.synchronous}`);
	db.exec(`PRAGMA foreign_keys = ${NATIVE_PRAGMAS.foreign_keys}`);
	db.exec(`PRAGMA busy_timeout = ${NATIVE_PRAGMAS.busy_timeout}`);
}

function disableExtensions(db: DatabaseSync, disable?: boolean): void {
	if (disable === false) return;
	if (!("enableLoadExtension" in db)) return;
	const host: LoadExtensionHost = db;
	if (host.enableLoadExtension instanceof Function) {
		host.enableLoadExtension(false);
	}
}

function wrapDatabaseSync(
	db: DatabaseSync,
	kind: SqliteDriver["kind"],
): SqliteDriver {
	return {
		kind,
		exec(sql: string) {
			db.exec(sql);
		},
		prepare(sql: string): SqliteStatement {
			const stmt = db.prepare(sql);
			return {
				run(...params: SqliteValue[]): SqliteRunResult {
					const normalized = normalizeParams(params);
					const raw = stmt.run(...normalized);
					// SAFETY: node:sqlite run() returns changes + lastInsertRowid.
					const result: SqliteNativeRunResult = raw;
					const changes = isJsonBigInt(result.changes)
						? Number(result.changes)
						: result.changes;
					return {
						changes,
						lastInsertRowid: result.lastInsertRowid,
					};
				},
				get(...params: SqliteValue[]) {
					const normalized = normalizeParams(params);
					const row = stmt.get(...normalized);
					if (row === undefined) return undefined;
					// SAFETY: sqlite row objects are column maps of SqliteValue.
					const mapped: SqliteRow = row;
					return mapped;
				},
				all(...params: SqliteValue[]) {
					const normalized = normalizeParams(params);
					const rows = stmt.all(...normalized);
					// SAFETY: sqlite row objects are column maps of SqliteValue.
					const mapped: SqliteRow[] = rows;
					return mapped;
				},
			};
		},
		beginImmediate() {
			db.exec("BEGIN IMMEDIATE");
		},
		commit() {
			db.exec("COMMIT");
		},
		rollback() {
			db.exec("ROLLBACK");
		},
		pragma(name: string, value?: string | number) {
			if (value === undefined) {
				// SAFETY: assertion required at this I/O or test boundary.
				const row = db.prepare(`PRAGMA ${name}`).get();
				if (!row) return null;
				const v = Object.values(row)[0];
				if (isJsonString(v) || isJsonNumber(v)) return v;
				return v === null || v === undefined ? null : String(v);
			}
			db.exec(`PRAGMA ${name} = ${value}`);
			return value;
		},
		close() {
			db.close();
		},
	};
}

function normalizeParams(params: SqliteValue[]): NativeBindValue[] {
	return params.map((value) => {
		if (value === true) return 1;
		if (value === false) return 0;
		return value;
	});
}
