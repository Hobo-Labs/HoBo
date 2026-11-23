export const SQLITE_DATA_ERROR_CODES = [
	"CAPTURE_POSITION_INVALID",
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
