/**
 * The SQL the libSQL binding sends: one table, one statement per port call.
 *
 * Every conditional write is a single statement — an `INSERT … ON CONFLICT DO
 * UPDATE … WHERE` upsert, or an `UPDATE`/`DELETE` with the condition in its
 * `WHERE` — so it is atomic on its own: SQLite runs each statement in its own
 * write transaction, and a libSQL server (Turso, `sqld`) serialises writes to a
 * database. No read-then-write crosses a round trip, which is what makes the
 * binding correct under independent concurrent clients without a lock.
 *
 * `RETURNING` reports the outcome. A conditional write that did not apply
 * returns no row; `rowsAffected` is not used, because the local `file:` driver
 * reports 0 for any statement that returns rows.
 *
 * Time. Expiry is an absolute `e` in Unix milliseconds. "Now" is
 * `coalesce(?n, <server clock>)`: the binding binds `null` to use the
 * database's own clock (the default — one clock for every client, like Redis
 * TTLs), or a number from an injected clock (tests). SQLite evaluates `'now'`
 * once per statement step, so every reference within one statement agrees.
 *
 * Changing any statement here changes `contracts/libsql-ephemeral-state.pact.json`.
 */

/** Unix milliseconds by the database's clock; `julianday` keeps sub-second precision on every SQLite. */
const SERVER_NOW_MS =
	"CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

const now = (index: number): string => `coalesce(?${index}, ${SERVER_NOW_MS})`;

/** The largest safe JavaScript integer; a counter never leaves this range. */
const MAX_SAFE = "9007199254740991";

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;

// public-contract: table name a deployed database holds the relay cache in; renaming it strands live rows.
export const DEFAULT_LIBSQL_EPHEMERAL_TABLE = "hobo_ephemeral_state";

/** Keys a `getMany` sends in one statement; more are split into one batch. */
export const LIBSQL_GET_MANY_CHUNK = 256;

/** `Uint8Array` carries a value as UTF-8 bytes, so an embedded NUL survives every driver. */
export type LibsqlArg = string | bigint | Uint8Array | null;

/** One SQL statement with positional arguments, as `@libsql/client` accepts it. */
export interface LibsqlStatement {
	readonly sql: string;
	readonly args: LibsqlArg[];
}

export type LibsqlStatements = ReturnType<typeof libsqlStatements>;

export function isLibsqlTableName(value: string): boolean {
	return TABLE_NAME.test(value);
}

/**
 * Statement builders for one table. `nowMs` is `null` for the server clock.
 * Arguments are bound positionally; integers are `bigint` so SQLite does
 * integer, not floating-point, arithmetic on revisions, counters and expiry.
 */
export function libsqlStatements(table: string) {
	if (!isLibsqlTableName(table)) {
		throw new RangeError(
			"libSQL table name must be 1..63 characters of [A-Za-z0-9_], not starting with a digit",
		);
	}
	const t = `"${table}"`;
	return {
		/**
		 * `WITHOUT ROWID` keeps one b-tree keyed by `k`, so a point lookup reads
		 * one row. `v` holds a value as UTF-8 bytes (a BLOB: the local driver
		 * truncates TEXT at an embedded NUL) or a counter as decimal TEXT. The `e` index lets the purge find expired rows without a
		 * table scan (a scan is billed as every row read).
		 */
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

		/** Creates the key, or replaces an expired row of it with a new incarnation. */
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

		/** Removes the row whether live or expired; reports whether it was live. */
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

		/**
		 * Add `by` to a live integer value, or start a missing or expired key at
		 * `by` with a new incarnation. The `WHERE` refuses a live value that is
		 * not a decimal integer of at most 16 digits, or a sum outside the safe
		 * range — then no row returns and the call is rejected with the stored
		 * value untouched, never reset or turned into a float.
		 */
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
			// instr(v, x'00') = 0: a NUL would end the TEXT view early and pass the digit check.
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

		/**
		 * Delete at most `limit` expired rows, oldest first, through the `e`
		 * index — never a table scan.
		 */
		purge: (limit: bigint, nowMs: bigint | null): LibsqlStatement => ({
			sql: `DELETE FROM ${t} WHERE k IN (SELECT k FROM ${t} WHERE e <= ${now(1)} ORDER BY e LIMIT ?2) RETURNING 1`,
			args: [nowMs, limit],
		}),
	};
}
