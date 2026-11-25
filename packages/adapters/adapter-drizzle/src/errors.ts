/**
 * Typed refusals for the drizzle adapter.
 *
 * This adapter has exactly two ways to disappoint a caller: it was handed
 * something it cannot read as a schema module, or it was asked to emit SQL
 * without the drizzle-kit toolchain that actually produces that SQL. Both
 * refuse with a machine-readable `code` and human-actionable `remediation`
 * rather than degrading. A best-effort SQL approximation would be a
 * portability lie that only surfaces against a production database, which is
 * precisely the class of failure the fail-closed rule exists to prevent.
 */

export const DRIZZLE_ADAPTER_ERROR_CODES = Object.freeze([
	"DRIZZLE_INGEST_INPUT_INVALID",
	"DRIZZLE_DIALECT_UNSUPPORTED",
	"TOOLCHAIN_UNAVAILABLE",
	"SQL_EMISSION_INCOMPLETE",
] as const);

export type DrizzleAdapterErrorCode =
	(typeof DRIZZLE_ADAPTER_ERROR_CODES)[number];

/**
 * The one error type this package throws. `code` is the stable contract;
 * `message` is for humans and may be reworded, so tests assert on `code`.
 */
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
