import type { SqlExecutor, SqlParameter, SqlRow } from "@hobo/data-postgres";
import pg from "pg";

type PgRows = { rows: SqlRow[] };
type PgClient = {
	query(sql: string, values?: SqlParameter[]): Promise<PgRows>;
	release(error?: Error | boolean): void;
};
/** The part of a `pg` pool the fleet uses. */
export type PgPool = {
	query(sql: string, values?: SqlParameter[]): Promise<PgRows>;
	connect(): Promise<PgClient>;
};

/** The `pg` adapter for the fleet's SQL executor port.
 *
 * Every fleet statement casts its result columns to text, so rows pass through
 * as they are. A session is one checked-out client; when its callback rejects
 * the client is destroyed, because it may still hold an open transaction. */
export function pgExecutor(pool: PgPool): SqlExecutor {
	return {
		query: (sql, parameters) =>
			parameters === undefined
				? pool.query(sql)
				: pool.query(sql, [...parameters]),
		async session(run) {
			const client = await pool.connect();
			let failed = true;
			try {
				const result = await run({
					query: (sql, parameters) =>
						parameters === undefined
							? client.query(sql)
							: client.query(sql, [...parameters]),
				});
				failed = false;
				return result;
			} finally {
				client.release(failed);
			}
		},
	};
}

/** Raised instead of sending a statement the fence no longer allows. */
export class DatabaseFenceError extends Error {
	constructor() {
		super("database assignment is no longer confirmed");
		this.name = "DatabaseFenceError";
	}
}

/** A `pg` client class that calls `beforeStatement` for every statement it
 * sends, whether the statement came through the pool or a checked-out client.
 * The hook counts the statement and may throw to refuse it. `ROLLBACK` is never
 * refused: it cannot write, and a refused transaction must be able to end. */
export function meteredClient(
	beforeStatement: (refusable: boolean) => void,
): typeof pg.Client {
	class MeteredClient extends pg.Client {}
	const send = pg.Client.prototype.query;
	// SAFETY: the wrapper forwards its arguments unchanged to the original
	// `query`, so every overload keeps its own parameter and result types.
	MeteredClient.prototype.query = function meteredQuery(
		this: pg.Client,
		...parameters: Parameters<typeof send>
	) {
		const [first] = parameters;
		beforeStatement(first !== "ROLLBACK");
		return send.apply(this, parameters);
	} as typeof send;
	return MeteredClient;
}
