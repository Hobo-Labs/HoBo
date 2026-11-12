/**
 * The SQL executor port the fleet is written against.
 *
 * The fleet opens no connection of its own. A host hands it one executor per
 * backend, and every statement the fleet sends goes through that port, so the
 * host decides the driver, the pooling, the TLS policy and where a credential
 * comes from. Two properties keep the port small enough to implement over any
 * driver:
 *
 * - **Every result column is text.** Each statement here casts what it selects
 *   to `text`, so a driver never has to agree with another driver about how a
 *   `bigint`, a `boolean` or a `timestamptz` is decoded. The fleet parses the
 *   text itself, once, into a derived type.
 * - **A session is the only stateful thing.** `session` pins one connection for
 *   the duration of a callback; the fleet issues `BEGIN`, `COMMIT` and
 *   `ROLLBACK` itself, which works through a transaction-mode pooler because a
 *   pooler pins a connection for exactly that span.
 */
import type { FleetFailureClass } from "@hobo/backend-routing";
import { PostgresDataError } from "../errors.js";

// Backend ids and failure classes are engine-neutral (`@hobo/backend-routing`).
export {
	FLEET_FAILURE_CLASSES,
	type FleetFailureClass,
	parseFleetBackendId,
} from "@hobo/backend-routing";

export type SqlParameter = string | number | boolean | null;

/** One result row. Columns the statement did not select are absent. */
export type SqlRow = { readonly [column: string]: string | null };

export type SqlResult = { readonly rows: readonly SqlRow[] };

export type SqlSession = {
	query(sql: string, parameters?: readonly SqlParameter[]): Promise<SqlResult>;
};

export type SqlExecutor = SqlSession & {
	/**
	 * Run `run` on one pinned connection. An implementation must discard the
	 * connection when `run` rejects: a rejected callback can leave a transaction
	 * open, and a pooled connection must never carry one to its next borrower.
	 */
	session<T>(run: (session: SqlSession) => Promise<T>): Promise<T>;
};

/** One member of a fleet: an opaque id and the way to reach it. */
export type FleetBackend = {
	readonly id: string;
	readonly executor: SqlExecutor;
};

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;

/**
 * A lower-case unquoted PostgreSQL identifier. Table names and prefixes are
 * interpolated into statements, so they are refused here unless they are plain.
 */
export function parseFleetIdentifier(value: string, field: string): string {
	if (!IDENTIFIER.test(value))
		throw new PostgresDataError(
			"FLEET_CONFIGURATION_INVALID",
			`${field} must be a lower-case PostgreSQL identifier`,
			{ detail: { field } },
		);
	return value;
}

/** Quote an identifier read back from the catalog. */
export function quoteIdentifier(value: string): string {
	if (value.length === 0 || value.includes("\u0000"))
		throw new PostgresDataError(
			"FLEET_RECORD_INVALID",
			"catalog returned an unusable identifier",
		);
	return `"${value.replaceAll('"', '""')}"`;
}

/** Read a required text column. */
export function column(row: SqlRow, name: string): string {
	const value = row[name];
	if (value === undefined || value === null)
		throw new PostgresDataError(
			"FLEET_RECORD_INVALID",
			`column ${name} is missing from a fleet record`,
			{ detail: { column: name } },
		);
	return value;
}

/** Read a nullable text column. */
export function optionalColumn(row: SqlRow, name: string): string | undefined {
	return row[name] ?? undefined;
}

/** Parse a non-negative safe integer that arrived as text. */
export function parseCount(value: string, field: string): number {
	const parsed = /^\d{1,16}$/u.test(value) ? Number(value) : Number.NaN;
	if (!Number.isSafeInteger(parsed))
		throw new PostgresDataError(
			"FLEET_RECORD_INVALID",
			`${field} is not a non-negative safe integer`,
			{ detail: { field } },
		);
	return parsed;
}

export function parseFlag(value: string, field: string): boolean {
	if (value === "true" || value === "t") return true;
	if (value === "false" || value === "f") return false;
	throw new PostgresDataError(
		"FLEET_RECORD_INVALID",
		`${field} is not a boolean`,
		{ detail: { field } },
	);
}

/**
 * Run `run` inside one transaction on one session.
 *
 * `begin` is the whole opening statement, so a caller chooses the isolation
 * level. A failed `ROLLBACK` is swallowed: the original failure is the one the
 * caller needs, and the executor discards the connection when this rejects.
 */
export async function inTransaction<T>(
	executor: SqlExecutor,
	begin: string,
	run: (session: SqlSession) => Promise<T>,
): Promise<T> {
	return executor.session(async (session) => {
		await session.query(begin);
		try {
			const result = await run(session);
			await session.query("COMMIT");
			return result;
		} catch (error) {
			try {
				await session.query("ROLLBACK");
			} catch {
				// The executor discards this connection because the callback rejects.
			}
			throw error;
		}
	});
}

const QUOTA_MESSAGE =
	/exceeded the [a-z -]*quota|quota (?:has been |was |is )?exceeded|over (?:its |the |your )?quota|plan limit|usage limit|limit (?:has been )?(?:reached|exceeded)/iu;
const AUTH_MESSAGE =
	/password authentication failed|authentication failed|no pg_hba\.conf entry|role "[^"]*" does not exist|permission denied for database/iu;
const NETWORK_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
]);
const NETWORK_MESSAGE =
	/timeout|timed out|connection terminated|connection refused|connection reset|could not connect|server closed the connection|the database system is (?:starting up|shutting down)/iu;

/**
 * Classify a failed statement from its SQLSTATE or driver code and its text.
 *
 * Only the class leaves this function. The message is read and never returned,
 * because a driver's message can carry a host name or a connection string.
 */
export function classifyFleetFailure(
	error: Error | undefined,
): FleetFailureClass {
	if (error === undefined) return "unknown";
	const code = "code" in error ? String(error.code) : "";
	// 53xxx is "insufficient resources"; a provider that enforces a plan reports
	// it either there or only in the message, so the message is checked first.
	if (QUOTA_MESSAGE.test(error.message)) return "quota-exhausted";
	if (code.startsWith("28") || AUTH_MESSAGE.test(error.message)) return "auth";
	if (code === "53100" || code === "53400") return "quota-exhausted";
	if (
		code.startsWith("08") ||
		code.startsWith("57P") ||
		code === "53300" ||
		NETWORK_CODES.has(code) ||
		NETWORK_MESSAGE.test(error.message)
	)
		return "unreachable";
	return "unknown";
}

/** SQLSTATE of a failed statement, when the driver exposed one. */
export function sqlState(error: Error | undefined): string | undefined {
	if (error === undefined || !("code" in error)) return undefined;
	const code = String(error.code);
	return /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
}
