import { PostgresDataError } from "../errors.js";
import { isText } from "./guards.js";

export type PostgresParameter = string | null;

export type PostgresRow = { readonly [column: string]: string | null };

// domain-view:
export interface PostgresQueryResult {
	readonly rows: readonly PostgresRow[];
	readonly rowCount: number;
}

export interface PostgresExecutor {
	query(
		sql: string,
		parameters?: readonly PostgresParameter[],
	): Promise<PostgresQueryResult>;
	transaction<T>(body: (tx: PostgresExecutor) => Promise<T>): Promise<T>;
}

export function sqlStateOf(cause: unknown): string | undefined {
	if (!(cause instanceof Error) || !("code" in cause)) return undefined;
	const code = cause.code;
	return isText(code) && /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
}

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

export interface PgPoolLike extends PgQueryableLike {
	connect(): Promise<PgClientLike>;
}

function textCell(column: string, cell: PgCellLike): string | null {
	if (cell === null || cell === undefined) return null;
	if (isText(cell)) return cell;
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

export function createPgExecutor(pool: PgPoolLike): PostgresExecutor {
	return {
		query: (sql, parameters = []) => run(pool, sql, parameters),
		async transaction(body) {
			const client = await pool.connect();
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
