const SERVER_NOW_MS =
	"CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

const now = (index: number): string => `coalesce(?${index}, ${SERVER_NOW_MS})`;

const MAX_SAFE = "9007199254740991";

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;

// public-contract: table name a deployed database holds the relay cache in; renaming it strands live rows.
export const DEFAULT_LIBSQL_EPHEMERAL_TABLE = "hobo_ephemeral_state";

export const LIBSQL_GET_MANY_CHUNK = 256;

export type LibsqlArg = string | bigint | Uint8Array | null;

export interface LibsqlStatement {
	readonly sql: string;
	readonly args: LibsqlArg[];
}

export type LibsqlStatements = ReturnType<typeof libsqlStatements>;

export function isLibsqlTableName(value: string): boolean {
	return TABLE_NAME.test(value);
}

export function libsqlStatements(table: string) {
	if (!isLibsqlTableName(table)) {
		throw new RangeError(
			"libSQL table name must be 1..63 characters of [A-Za-z0-9_], not starting with a digit",
		);
	}
	const t = `"${table}"`;
	return {
		schema: [
			`CREATE TABLE IF NOT EXISTS ${t} (k TEXT PRIMARY KEY NOT NULL, v BLOB NOT NULL, i TEXT NOT NULL, r INTEGER NOT NULL, e INTEGER NOT NULL) WITHOUT ROWID`,
			`CREATE INDEX IF NOT EXISTS "${table}_e" ON ${t} (e)`,
		],

		get: (key: string, nowMs: bigint | null): LibsqlStatement => ({
			sql: `SELECT v, i, r FROM ${t} WHERE k = ?1 AND e > ${now(2)}`,
			args: [key, nowMs],
		}),

		getMany: (
			keys: readonly string[],
			nowMs: bigint | null,
		): LibsqlStatement => ({
			sql: `SELECT k, v, i, r FROM ${t} WHERE k IN (${keys.map((_, index) => `?${index + 2}`).join(", ")}) AND e > ${now(1)}`,
			args: [nowMs, ...keys],
		}),

		putIfAbsent: (
			key: string,
			value: Uint8Array,
			incarnation: string,
			ttlMs: bigint,
			nowMs: bigint | null,
		): LibsqlStatement => ({
			sql: `INSERT INTO ${t} (k, v, i, r, e) VALUES (?1, ?2, ?3, 1, ${now(5)} + ?4) ON CONFLICT (k) DO UPDATE SET v = excluded.v, i = excluded.i, r = 1, e = excluded.e WHERE ${t}.e <= ${now(5)} RETURNING i, r`,
			args: [key, value, incarnation, ttlMs, nowMs],
		}),

		compareAndSet: (
			key: string,
			expected: string,
			value: Uint8Array,
			ttlMs: bigint,
			nowMs: bigint | null,
		): LibsqlStatement => ({
			sql: `UPDATE ${t} SET v = ?3, r = r + 1, e = ${now(5)} + ?4 WHERE k = ?1 AND e > ${now(5)} AND (i || ':' || r) = ?2 RETURNING i, r`,
			args: [key, expected, value, ttlMs, nowMs],
		}),

		delete: (key: string, nowMs: bigint | null): LibsqlStatement => ({
			sql: `DELETE FROM ${t} WHERE k = ?1 RETURNING e > ${now(2)}`,
			args: [key, nowMs],
		}),

		deleteIfVersion: (
			key: string,
			expected: string,
			nowMs: bigint | null,
		): LibsqlStatement => ({
			sql: `DELETE FROM ${t} WHERE k = ?1 AND e > ${now(3)} AND (i || ':' || r) = ?2 RETURNING 1`,
			args: [key, expected, nowMs],
		}),

		increment: (
			key: string,
			by: bigint,
			incarnation: string,
			ttlMs: bigint,
			mode: "on-create" | "refresh",
			nowMs: bigint | null,
		): LibsqlStatement => {
			const expired = `${t}.e <= ${now(6)}`;
			const asText = `CAST(${t}.v AS TEXT)`;
			const digits = `(CASE WHEN substr(${asText}, 1, 1) = '-' THEN substr(${asText}, 2) ELSE ${asText} END)`;
			const integerText = `(instr(${t}.v, x'00') = 0 AND length(${digits}) BETWEEN 1 AND 16 AND ${digits} NOT GLOB '*[^0-9]*')`;
			const inRange = `abs(CAST(${t}.v AS INTEGER) + ?2) <= ${MAX_SAFE}`;
			return {
				sql: `INSERT INTO ${t} (k, v, i, r, e) VALUES (?1, CAST(?2 AS TEXT), ?3, 1, ${now(6)} + ?4) ON CONFLICT (k) DO UPDATE SET v = CASE WHEN ${expired} THEN excluded.v ELSE CAST(CAST(${t}.v AS INTEGER) + ?2 AS TEXT) END, i = CASE WHEN ${expired} THEN excluded.i ELSE ${t}.i END, r = CASE WHEN ${expired} THEN 1 ELSE ${t}.r + 1 END, e = CASE WHEN ${expired} OR ?5 = 'refresh' THEN excluded.e ELSE ${t}.e END WHERE ${expired} OR (${integerText} AND ${inRange}) RETURNING v`,
				args: [key, by, incarnation, ttlMs, mode, nowMs],
			};
		},

		expire: (
			key: string,
			ttlMs: bigint,
			nowMs: bigint | null,
		): LibsqlStatement => ({
			sql: `UPDATE ${t} SET e = ${now(3)} + ?2 WHERE k = ?1 AND e > ${now(3)} RETURNING 1`,
			args: [key, ttlMs, nowMs],
		}),

		purge: (limit: bigint, nowMs: bigint | null): LibsqlStatement => ({
			sql: `DELETE FROM ${t} WHERE k IN (SELECT k FROM ${t} WHERE e <= ${now(1)} ORDER BY e LIMIT ?2) RETURNING 1`,
			args: [nowMs, limit],
		}),
	};
}
