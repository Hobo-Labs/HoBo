/**
 * Stable error codes for the provider-neutral PostgreSQL surface.
 *
 * This package never talks to a provider, so the codes here are the ones a
 * *caller* can act on: a malformed authoring input, an argv the package refuses
 * to build, or a conformance suite that was asked to prove something it has no
 * executor for. Provider transport codes live in the provider packages.
 */

export const POSTGRES_DATA_ERROR_CODES = [
	"INVALID_POSTGRES_REQUIREMENT",
	"UNSAFE_COMMAND_ARGUMENT",
	"MIGRATION_FAILED",
	"CONFORMANCE_SUITE_INVALID",
	"CONFORMANCE_EXECUTOR_MISSING",
	// Engine binding (src/engine): failures of the binding itself, as opposed
	// to the engine-neutral refusals, which are `DataCoreError`s.
	"ENGINE_OPTIONS_INVALID",
	"ENGINE_EXECUTOR_CONTRACT",
	"CAPTURE_POSITION_INVALID",
	"CAPTURE_SUBSCRIPTION_LOST",
	"CAPTURE_STREAM_UNDECODABLE",
	// Native transfer (logical-copy). Both carry a SQLSTATE and nothing else:
	// the server's own text can quote the connection string it was given.
	"NATIVE_SUBSCRIBE_FAILED",
	"NATIVE_STOP_FAILED",
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
