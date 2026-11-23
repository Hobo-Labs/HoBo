export const DRIZZLE_ADAPTER_ERROR_CODES = Object.freeze([
	"DRIZZLE_INGEST_INPUT_INVALID",
	"DRIZZLE_DIALECT_UNSUPPORTED",
	"TOOLCHAIN_UNAVAILABLE",
	"SQL_EMISSION_INCOMPLETE",
] as const);

export type DrizzleAdapterErrorCode =
	(typeof DRIZZLE_ADAPTER_ERROR_CODES)[number];

export class DrizzleAdapterError extends Error {
	readonly code: DrizzleAdapterErrorCode;
	readonly remediation: string;

	constructor(
		code: DrizzleAdapterErrorCode,
		message: string,
		remediation: string,
	) {
		super(`${message} Remediation: ${remediation}`);
		this.name = "DrizzleAdapterError";
		this.code = code;
		this.remediation = remediation;
	}
}
