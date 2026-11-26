/**
 * How a check's exit code becomes its status, and how the checks of a run
 * become the record's status and the runner's exit code (ADR-0172).
 *
 * A gate is a conjunction: the record passes only when every check passed. A
 * failed check makes it `failed`. A check that could not be carried out (an
 * exit code its definition lists in `notRunExitCodes`) is `not_run`, and with
 * no failure beside it the record is `not_run`: it says nothing about the
 * product either way, so it is neither passed nor failed. A check whose
 * `requires` did not all pass is `skipped` and never started.
 */
import type {
	CheckEvidence,
	CheckResult,
	CheckStatus,
	RecordStatus,
	StageGateCheck,
} from "./types.js";

// public-contract: the variable a check that `requires` others reads their evidence from (scripts/check-acceptance.mts does).
export const REQUIRED_EVIDENCE_ENV = "HOBO_STAGE_GATE_REQUIRED_EVIDENCE";

/**
 * How much of a check's stdout, and of its stderr, the runner captures; a
 * check that writes more is killed for it. The one output bound: a check that
 * relays another process's output (check-acceptance.mts) relays less.
 */
export const CHECK_OUTPUT_LIMIT = 16 * 1024 * 1024;

/** The exit code recorded for a check that was never started. */
export const NOT_STARTED_EXIT_CODE = -1;

/** The runner's exit code for a record with a `not_run` check and no failed one (ai-bdd's infrastructure code). */
export const NOT_RUN_EXIT_CODE = 3;

export function checkStatusOf(
	check: StageGateCheck,
	exitCode: number,
): CheckStatus {
	if (exitCode === 0) return "passed";
	return check.notRunExitCodes?.includes(exitCode) ? "not_run" : "failed";
}

/** The `requires` of a check that have not passed in this run, in the order the check lists them. */
export function unmetRequirements(
	check: StageGateCheck,
	passed: ReadonlyMap<string, CheckEvidence>,
): readonly string[] {
	return (check.requires ?? []).filter((checkId) => !passed.has(checkId));
}

/**
 * The evidence of the checks a check requires, as one JSON object keyed by
 * check id: what the check is handed in REQUIRED_EVIDENCE_ENV, so a later
 * check works on the earlier one's result instead of re-reading the disk.
 * `undefined` for a check that requires nothing.
 */
export function requiredEvidenceOf(
	check: StageGateCheck,
	passed: ReadonlyMap<string, CheckEvidence>,
): string | undefined {
	const required = check.requires ?? [];
	if (required.length === 0) return undefined;
	return JSON.stringify(
		Object.fromEntries(required.map((id) => [id, passed.get(id) ?? {}])),
	);
}

export function recordStatusOf(checks: readonly CheckResult[]): RecordStatus {
	if (checks.some((check) => check.status === "failed")) return "failed";
	if (checks.some((check) => check.status === "not_run")) return "not_run";
	// A skipped check beside no failure is a definition whose requirement can never pass: not a pass.
	return checks.every((check) => check.status === "passed")
		? "passed"
		: "failed";
}

export function runnerExitCodeOf(status: RecordStatus): number {
	if (status === "passed") return 0;
	return status === "not_run" ? NOT_RUN_EXIT_CODE : 1;
}
