/**
 * Stable error codes for failures that are the SQLite binding's own.
 *
 * The engine-neutral refusals — a fenced write, an invalid record, a refused
 * retire — are `DataCoreError`s from `@hobo/data-core`. These are the ones the
 * neutral contract has no code for. `CAPTURE_POSITION_INVALID` is spelled as
 * the PostgreSQL binding spells it, so a caller can match either engine.
 */

export const SQLITE_DATA_ERROR_CODES = [
	// A capture position this store never minted, or one whose changes it has
	// already released. Never answered with an empty "caught up" batch.
	"CAPTURE_POSITION_INVALID",
	// A verify query carried SQL after its first statement; SQLite would have
	// compiled the first and silently ignored the rest.
	"SCHEMA_QUERY_NOT_SINGLE",
] as const;

export type SqliteDataErrorCode = (typeof SQLITE_DATA_ERROR_CODES)[number];

export type SqliteDataErrorDetail = Readonly<
	Record<string, string | number | boolean>
>;

export type SqliteDataErrorOptions = {
	readonly detail?: SqliteDataErrorDetail;
};

export class SqliteDataError extends Error {
	readonly code: SqliteDataErrorCode;
	readonly detail: SqliteDataErrorDetail;

	constructor(
		code: SqliteDataErrorCode,
		message: string,
		options: SqliteDataErrorOptions = {},
	) {
		super(message);
		this.name = "SqliteDataError";
		this.code = code;
		this.detail = Object.freeze(options.detail ?? {});
	}
}
