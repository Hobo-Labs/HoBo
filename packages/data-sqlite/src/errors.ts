/**
 * Stable error codes for failures that are the SQLite binding's own.
 *
 * The engine-neutral refusals — a fenced write, an invalid record, a refused
 * retire, a capture position that cannot be read or acknowledged — are
 * `DataCoreError`s from `@hobo/data-core`. These are the ones the neutral
 * contract has no code for.
 *
 * `CAPTURE_POSITION_INVALID` stays in the list so the exported names keep
 * meaning what they did, but the binding no longer raises a `SqliteDataError`
 * with it: the code is shared now, and a refused position is the
 * `CapturePositionError` every engine raises (`code` is the same text).
 */

export const SQLITE_DATA_ERROR_CODES = [
	// Shared since `@hobo/data-core` owns it; see the module note.
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
