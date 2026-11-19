
export const POSTGRES_DATA_ERROR_CODES = [
	"INVALID_POSTGRES_REQUIREMENT",
	"UNSAFE_COMMAND_ARGUMENT",
	"MIGRATION_FAILED",
	"CONFORMANCE_SUITE_INVALID",
	"CONFORMANCE_EXECUTOR_MISSING",
	"ENGINE_OPTIONS_INVALID",
	"ENGINE_EXECUTOR_CONTRACT",
	"CAPTURE_POSITION_INVALID",
	"CAPTURE_SUBSCRIPTION_LOST",
	"CAPTURE_STREAM_UNDECODABLE",
	"CAPTURE_SLOT_UNPROVEN",
	"NATIVE_SUBSCRIBE_FAILED",
	"NATIVE_STOP_FAILED",
	"NATIVE_PAUSE_FAILED",
	"FLEET_CONFIGURATION_INVALID",
	"FLEET_RECORD_INVALID",
] as const;

export type PostgresDataErrorCode = (typeof POSTGRES_DATA_ERROR_CODES)[number];

export type PostgresDataErrorDetail = Readonly<
	Record<string, string | number | boolean>
>;

export type PostgresDataErrorOptions = {
	readonly detail?: PostgresDataErrorDetail;
	readonly cause?: unknown;
};

type PostgresErrorInput = PostgresDataError | Error | null;

export class PostgresDataError extends Error {
	readonly code: PostgresDataErrorCode;
	readonly detail: PostgresDataErrorDetail;

	constructor(
		code: PostgresDataErrorCode,
		message: string,
		options: PostgresDataErrorOptions = {},
	) {
		super(message, options.cause === undefined ? {} : { cause: options.cause });
		this.name = "PostgresDataError";
		this.code = code;
		this.detail = Object.freeze(options.detail ?? {});
	}
}

export function isPostgresDataError(
	value: PostgresErrorInput,
): value is PostgresDataError {
	return value instanceof PostgresDataError;
}
