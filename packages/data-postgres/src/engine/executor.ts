/**
 * The executor port: the one boundary between the engine binding and a live
 * server.
 *
 * The binding never imports a driver. It is handed something that can run a
 * parameterised statement and something that can run several inside one
 * transaction, and that is all it knows about connectivity — which is what
 * lets the same binding run over a TCP pool, an HTTP query endpoint, or a
 * test double.
 *
 * Every value crossing the port is text or NULL. The binding casts every
 * parameter and every selected column in SQL, so no driver-side type parsing
 * is involved and a value cannot be silently reinterpreted by a parser the
 * binding does not control (a `bigint` narrowed to a double, a timestamp
 * rounded to milliseconds).
 */
import { PostgresDataError } from "../errors.js";
import { isText } from "./guards.js";

/** A statement parameter: text the statement casts, or NULL. */
export type PostgresParameter = string | null;

/** One result row. Every column is text or NULL — see the module note. */
export type PostgresRow = { readonly [column: string]: string | null };

// domain-view: parsed executor response; wire form is PostgresExecutorResponse in data-models/postgres_engine.proto.
export interface PostgresQueryResult {
	readonly rows: readonly PostgresRow[];
	/** Rows affected by a write; 0 when the server reports none. */
	readonly rowCount: number;
}

export interface PostgresExecutor {
	/**
	 * Run one statement. A server error must reject with an `Error` whose
	 * `code` property is the five-character SQLSTATE.
	 */
	query(
		sql: string,
		parameters?: readonly PostgresParameter[],
	): Promise<PostgresQueryResult>;
	/**
	 * Run `body` on one session inside one transaction: commit when it
	 * resolves, roll back when it rejects. Statements issued through `tx` must
	 * all reach the same session, in order.
	 */
	transaction<T>(body: (tx: PostgresExecutor) => Promise<T>): Promise<T>;
}

/** The SQLSTATE a rejected statement carried, when it carried one. */
export function sqlStateOf(cause: unknown): string | undefined {
	if (!(cause instanceof Error) || !("code" in cause)) return undefined;
	const code = cause.code;
	return isText(code) && /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
}

// ── structural adapter for a node-postgres-like pool ────────────────────────

/** A cell as a driver may hand it over before the adapter checks it. */
export type PgCellLike =
	| string
	| number
	| bigint
	| boolean
	| Date
	| Uint8Array
	| null
	| undefined;

export type PgRowLike = { readonly [column: string]: PgCellLike };

export interface PgQueryResultLike {
	readonly rows: readonly PgRowLike[];
	readonly rowCount: number | null;
}

export interface PgQueryableLike {
	query(text: string, values: PostgresParameter[]): Promise<PgQueryResultLike>;
}

export interface PgClientLike extends PgQueryableLike {
	release(destroy?: boolean): void;
}

/** Anything with the two members of a node-postgres `Pool` this needs. */
export interface PgPoolLike extends PgQueryableLike {
	connect(): Promise<PgClientLike>;
}

function textCell(column: string, cell: PgCellLike): string | null {
	if (cell === null || cell === undefined) return null;
	if (isText(cell)) return cell;
	// A non-text cell means a statement forgot a cast and the driver parsed
	// the value. That is exactly the silent reinterpretation the port exists
	// to rule out, so it is an error rather than a coercion.
	throw new PostgresDataError(
		"ENGINE_EXECUTOR_CONTRACT",
		`column ${column} did not arrive as text; cast it in the statement`,
		{ detail: { column } },
	);
}

function textRow(row: PgRowLike): PostgresRow {
	return Object.fromEntries(
		Object.entries(row).map(([column, cell]) => [
			column,
			textCell(column, cell),
		]),
	);
}

async function run(
	queryable: PgQueryableLike,
	sql: string,
	parameters: readonly PostgresParameter[],
): Promise<PostgresQueryResult> {
	const result = await queryable.query(sql, [...parameters]);
	return { rows: result.rows.map(textRow), rowCount: result.rowCount ?? 0 };
}

function sessionExecutor(
	client: PgQueryableLike,
	depth: number,
): PostgresExecutor {
	return {
		query: (sql, parameters = []) => run(client, sql, parameters),
		// A nested transaction is a savepoint on the same session.
		async transaction(body) {
			const savepoint = `hobo_savepoint_${depth}`;
			await client.query(`SAVEPOINT ${savepoint}`, []);
			try {
				const result = await body(sessionExecutor(client, depth + 1));
				await client.query(`RELEASE SAVEPOINT ${savepoint}`, []);
				return result;
			} catch (cause) {
				await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`, []);
				throw cause;
			}
		},
	};
}

/**
 * Adapt a node-postgres-like pool to the executor port. Structural: this
 * package does not import the driver, so any object with `query` and
 * `connect` fits. The pool stays owned by the caller, who ends it.
 */
export function createPgExecutor(pool: PgPoolLike): PostgresExecutor {
	return {
		query: (sql, parameters = []) => run(pool, sql, parameters),
		async transaction(body) {
			const client = await pool.connect();
			// A session whose rollback failed is in an unknown state; it is
			// destroyed rather than returned to the pool.
			let destroy = false;
			try {
				await client.query("BEGIN", []);
				try {
					const result = await body(sessionExecutor(client, 1));
					await client.query("COMMIT", []);
					return result;
				} catch (cause) {
					try {
						await client.query("ROLLBACK", []);
					} catch {
						destroy = true;
					}
					throw cause;
				}
			} finally {
				client.release(destroy);
			}
		},
	};
}
