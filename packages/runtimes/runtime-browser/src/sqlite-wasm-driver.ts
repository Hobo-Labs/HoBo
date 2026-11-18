import type {
	SqliteDriver,
	SqliteRow,
	SqliteRunResult,
	SqliteStatement,
	SqliteValue,
} from "@hobo/storage-sqlite/browser";
import type sqlite3InitModule from "@sqlite.org/sqlite-wasm";

type SqliteModule = Awaited<ReturnType<typeof sqlite3InitModule>>;
type SqliteDatabase = InstanceType<SqliteModule["oo1"]["DB"]>;
type SqliteResult =
	| string
	| number
	| bigint
	| null
	| Uint8Array
	| Int8Array
	| ArrayBuffer;

function toSqliteValue(value: SqliteResult): Exclude<SqliteValue, boolean> {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (value instanceof Int8Array)
		return new Uint8Array(
			value.buffer,
			value.byteOffset,
			value.byteLength,
		).slice();
	return value;
}

function rowOf(row: Record<string, SqliteResult>): SqliteRow {
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => [key, toSqliteValue(value)]),
	);
}

function rowId(db: SqliteDatabase): number | bigint {
	const value = db.selectValue("SELECT last_insert_rowid()");
	if (Object.prototype.toString.call(value) === "[object BigInt]")
		return BigInt(String(value));
	if (Number.isSafeInteger(value)) return Number(value);
	throw new TypeError("SQLite returned an invalid row id");
}

export function createSqliteWasmDriver(db: SqliteDatabase): SqliteDriver {
	return {
		kind: "browser",
		exec(sql) {
			db.exec(sql);
		},
		prepare(sql): SqliteStatement {
			function read(
				params: readonly SqliteValue[],
				firstOnly: boolean,
			): SqliteRow[] {
				const statement = db.prepare(sql);
				try {
					if (params.length) statement.bind(params);
					const rows: SqliteRow[] = [];
					while (statement.step()) {
						rows.push(rowOf(statement.get({})));
						if (firstOnly) break;
					}
					return rows;
				} finally {
					statement.finalize();
				}
			}
			return {
				run(...params): SqliteRunResult {
					const statement = db.prepare(sql);
					try {
						if (params.length) statement.bind(params);
						while (statement.step()) {}
						return { changes: db.changes(), lastInsertRowid: rowId(db) };
					} finally {
						statement.finalize();
					}
				},
				get(...params) {
					return read(params, true)[0];
				},
				all(...params) {
					return read(params, false);
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
		pragma(name, value) {
			if (value !== undefined) {
				db.exec(`PRAGMA ${name} = ${value}`);
				return value;
			}
			const result = db.selectValue(`PRAGMA ${name}`);
			if (result === null || result === undefined) return null;
			if (Number.isFinite(result)) return Number(result);
			return String(result);
		},
		close() {
			db.close();
		},
	};
}
