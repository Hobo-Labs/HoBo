/**
 * What each port call costs on libSQL, in the two units Turso bills:
 * requests are not billed, rows are.
 *
 * Turso's definitions (https://docs.turso.tech/help/usage-and-billing, read
 * 2026-11-11 through the Context7 mirror of docs.turso.tech): a row read is a
 * row scanned while a statement runs — a full scan reads every row, an update
 * reads each row it updates; a row written is a row inserted, updated or
 * deleted, and an aborted transaction still counts the rows it modified.
 *
 * Each statement in `statements.ts` reaches at most one row through the
 * primary key, so a call reads at most one row (per key for `getMany`) and
 * writes at most one. The figures are upper bounds derived from those
 * definitions, not measurements: whether a primary-key lookup that finds
 * nothing bills a read, and whether maintaining the `e` index bills an extra
 * written row, is not documented. The relay budgets against the upper bound
 * and should compare it with the database's own stats
 * (`GET /v1/organizations/{org}/databases/{db}/stats`) once deployed.
 *
 * The purge (`purge` below) rides in the same request as a write at most once
 * per `purgeEveryMs` per client, so it adds no request; it reads at most
 * `2 × limit + 1` rows (index entries, then each row it deletes) and writes at
 * most `limit`. Every expired row is written once by the purge or by the
 * `putIfAbsent`/`increment` that replaces it, so purging moves cost in time
 * rather than adding it.
 */

// public-contract: per-operation libSQL cost the relay meters against Turso's rows allowance.
export const LIBSQL_EPHEMERAL_COST = Object.freeze({
	get: { requests: 1, rowsReadMax: 1, rowsWrittenMax: 0 },
	/** `rowsReadMax` is per key asked. More than 256 keys are split into statements of one batch: still one request. */
	getMany: { requests: 1, rowsReadMax: 1, rowsWrittenMax: 0, perKey: true },
	/** Writes only when it applies (creating the key, or replacing an expired row). */
	putIfAbsent: { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	/** Writes only when the version matches. */
	compareAndSet: { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	/** Unconditional delete also removes an expired row (and bills its write). */
	delete: { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	/** Always writes, except when it is rejected for a non-integer value. */
	increment: { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	expire: { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	"lock.acquire": { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	"lock.renew": { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	"lock.release": { requests: 1, rowsReadMax: 1, rowsWrittenMax: 1 },
	/** increment(seq) + putIfAbsent(entry) + delete(evicted). */
	"ring.append": { requests: 3, rowsReadMax: 3, rowsWrittenMax: 3 },
	/** get(seq) + getMany(window): 1 + window rows. */
	"ring.read": { requests: 2, rowsReadMax: 1, rowsWrittenMax: 0, perKey: true },
} as const);

export type LibsqlEphemeralOperation = keyof typeof LIBSQL_EPHEMERAL_COST;

/** Rows one port call was charged by the binding's own estimate. */
export type LibsqlRowsCharge = {
	readonly operation:
		| "get"
		| "getMany"
		| "putIfAbsent"
		| "compareAndSet"
		| "delete"
		| "increment"
		| "expire"
		| "purge";
	readonly rowsRead: number;
	readonly rowsWritten: number;
};

/**
 * Where a month's rows stand against an allowance. Turso's free plan blocks
 * the database when an allowance is exhausted rather than billing more
 * (https://turso.tech/pricing), so the relay switches cache backend before
 * `projected` reaches it.
 */
export const TURSO_FREE_ROWS_ALLOWANCE = Object.freeze({
	rowsReadPerMonth: 500_000_000,
	rowsWrittenPerMonth: 10_000_000,
} as const);
