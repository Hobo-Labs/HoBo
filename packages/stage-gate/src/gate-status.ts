import type {
	CheckEvidence,
	CheckResult,
	CheckStatus,
	RecordStatus,
	StageGateCheck,
} from "./types.js";

// public-contract: the variable a check that `requires` others reads their evidence from (scripts/check-acceptance.mts does).
export const REQUIRED_EVIDENCE_ENV = "HOBO_STAGE_GATE_REQUIRED_EVIDENCE";

export const CHECK_OUTPUT_LIMIT = 16 * 1024 * 1024;

export const NOT_STARTED_EXIT_CODE = -1;

export const NOT_RUN_EXIT_CODE = 3;

export function checkStatusOf(
	check: StageGateCheck,
	exitCode: number,
): CheckStatus {
	if (exitCode === 0) return "passed";
	return check.notRunExitCodes?.includes(exitCode) ? "not_run" : "failed";
}

export function unmetRequirements(
	check: StageGateCheck,
	passed: ReadonlyMap<string, CheckEvidence>,
): readonly string[] {
	return (check.requires ?? []).filter((checkId) => !passed.has(checkId));
}

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
	return checks.every((check) => check.status === "passed")
		? "passed"
		: "failed";
}

export function runnerExitCodeOf(status: RecordStatus): number {
	if (status === "passed") return 0;
	return status === "not_run" ? NOT_RUN_EXIT_CODE : 1;
}
