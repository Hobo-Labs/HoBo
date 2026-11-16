/**
 * Typed refusals for the out-of-box app test harness.
 *
 * Every gate in this package fails closed. A missing Yard, a missing
 * credential locator, an undetected runner, a cyclic topology, or a readiness
 * response that is an *answer* rather than a propagation delay all raise a
 * `TestHarnessError` carrying a stable `code` plus human-actionable
 * `remediation` text. The alternative — degrading the `ephemeral-camp` lane
 * into the `in-process` lane, or reporting a bare green tick over `mocked`
 * handles — would re-commit exactly the overclaim GAP-026 exists to prevent,
 * which ADR-0159 names a conformance failure of the harness itself.
 */

export const TEST_HARNESS_ERROR_CODES: readonly string[] = Object.freeze([
	"HARNESS_ALIAS_UNKNOWN",
	"HARNESS_BINDLE_INVALID",
	"HARNESS_CREDENTIAL_NOT_A_REF",
	"HARNESS_CREDENTIALS_REQUIRED",
	"HARNESS_CYCLIC_DEPENDENCY",
	"HARNESS_ENDPOINT_UNAVAILABLE",
	"HARNESS_LANE_INVALID",
	"HARNESS_LANE_UNIMPLEMENTED",
	"HARNESS_READINESS_EXHAUSTED",
	"HARNESS_READINESS_OPTIONS_INVALID",
	"HARNESS_READINESS_REJECTED",
	"HARNESS_RUNNER_INVALID",
	"HARNESS_RUNNER_UNDETECTED",
	"HARNESS_STAGE_INVALID",
	"HARNESS_YARD_INVALID",
	"HARNESS_YARD_REQUIRED",
]);

export type TestHarnessErrorCode =
	| "HARNESS_ALIAS_UNKNOWN"
	| "HARNESS_BINDLE_INVALID"
	| "HARNESS_CREDENTIAL_NOT_A_REF"
	| "HARNESS_CREDENTIALS_REQUIRED"
	| "HARNESS_CYCLIC_DEPENDENCY"
	| "HARNESS_ENDPOINT_UNAVAILABLE"
	| "HARNESS_LANE_INVALID"
	| "HARNESS_LANE_UNIMPLEMENTED"
	| "HARNESS_READINESS_EXHAUSTED"
	| "HARNESS_READINESS_OPTIONS_INVALID"
	| "HARNESS_READINESS_REJECTED"
	| "HARNESS_RUNNER_INVALID"
	| "HARNESS_RUNNER_UNDETECTED"
	| "HARNESS_STAGE_INVALID"
	| "HARNESS_YARD_INVALID"
	| "HARNESS_YARD_REQUIRED";

/**
 * The single refusal type this package throws. `remediation` is required, not
 * optional: a refusal that does not say what to change is a dead end for the
 * author and gets worked around rather than fixed.
 */
export class TestHarnessError extends Error {
	readonly code: TestHarnessErrorCode;
	readonly remediation: string;

	constructor(
		code: TestHarnessErrorCode,
		message: string,
		remediation: string,
	) {
		super(`${message} — remediation: ${remediation}`);
		this.name = "TestHarnessError";
		this.code = code;
		this.remediation = remediation;
	}
}

export function isTestHarnessError(value: unknown): value is TestHarnessError {
	return value instanceof TestHarnessError;
}
