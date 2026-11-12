// Parse boundary for VerificationSpecRecord (D9). A ParsedVerificationSpec has
// every default from CD_DEFAULTS applied and every constraint from
// data-models/verification.cue checked, so the engine never re-validates and
// never sees a spec that could pass on absent evidence.
import { clone, fromJson, type JsonValue } from "@bufbuild/protobuf";
import {
	Aggregation,
	Comparator,
	Direction,
	type HealthQueryRecord,
	HealthSourceKind,
	Sensitivity,
	type VerificationSpecRecord,
	VerificationSpecRecordSchema,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS } from "../events.js";
import type { Outcome } from "../ports.js";
import { reason, refuse, type VerificationReasonCode } from "./reasons.js";

export type ParsedVerificationSpec = VerificationSpecRecord & {
	readonly __brand: "cd.ParsedVerificationSpec";
};

/** Unit that marks a query as an error-budget burn-rate series. */
export const BURN_RATE_UNIT = "burn_rate";
/** Unit that marks a query as a ratio; samples outside [0, 1] are invalid. */
export const RATIO_UNIT = "ratio";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_QUERY_CHARS = 4096;
const MAX_REQUIRED_OBSERVATIONS = 10_000;
const MAX_WINDOW_MS = 7n * 24n * 3_600_000n;
const SENSITIVITY_DEFAULT: Readonly<Record<string, Sensitivity>> = {
	LOW: Sensitivity.LOW,
	MEDIUM: Sensitivity.MEDIUM,
	HIGH: Sensitivity.HIGH,
};

export const thresholdCheckId = (query: HealthQueryRecord) =>
	`threshold:${query.name}`;
export const comparisonCheckId = (query: HealthQueryRecord) =>
	`comparison:${query.name}`;
export const probeCheckId = (name: string) => `probe:${name}`;
export const suiteCheckId = (suite: string) => `suite:${suite}`;
export const ERROR_BUDGET_CHECK = "error-budget";

function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

type Problem = Readonly<{
	code: VerificationReasonCode;
	message: string;
	subject: string;
}>;

function checkQuery(
	query: HealthQueryRecord | undefined,
	path: string,
	problems: Problem[],
): void {
	if (!query) {
		problems.push({
			code: "verification-spec-invalid",
			message: `${path}.query is required`,
			subject: path,
		});
		return;
	}
	if (!NAME.test(query.name)) {
		problems.push({
			code: "verification-spec-invalid",
			message: `${path}.query.name must match ${NAME.source}`,
			subject: path,
		});
	}
	if (
		!(query.source in HealthSourceKind) ||
		query.source === HealthSourceKind.UNSPECIFIED
	) {
		problems.push({
			code: "verification-spec-invalid",
			message: `${path}.query.source must name a health source`,
			subject: path,
		});
	}
	if (query.query.trim() === "" || query.query.length > MAX_QUERY_CHARS) {
		problems.push({
			code: "verification-spec-invalid",
			message: `${path}.query.query must be 1..${MAX_QUERY_CHARS} characters`,
			subject: path,
		});
	}
	if (
		query.source !== HealthSourceKind.HOBO_POSTURE &&
		!isHttpsUrl(query.endpointRef)
	) {
		problems.push({
			code: "verification-spec-invalid",
			message: `${path}.query.endpoint_ref must be an https URL`,
			subject: path,
		});
	}
}

/** Apply defaults and constraints; refuse with every problem found, not just the first. */
export function parseVerificationSpec(
	input: VerificationSpecRecord,
): Outcome<ParsedVerificationSpec> {
	const spec = clone(VerificationSpecRecordSchema, input);
	const problems: Problem[] = [];

	if (spec.windowMs === 0n)
		spec.windowMs = BigInt(CD_DEFAULTS.verificationWindowMs);
	if (spec.requiredObservations === 0)
		spec.requiredObservations = CD_DEFAULTS.verificationRequiredObservations;
	if (spec.progressDeadlineMs === 0n)
		spec.progressDeadlineMs = BigInt(
			CD_DEFAULTS.verificationProgressDeadlineMs,
		);
	if (spec.windowMs > MAX_WINDOW_MS) {
		problems.push({
			code: "verification-spec-invalid",
			message: "window_ms must be at most 7 days",
			subject: "window_ms",
		});
	}
	if (spec.requiredObservations > MAX_REQUIRED_OBSERVATIONS) {
		problems.push({
			code: "verification-spec-invalid",
			message: `required_observations must be at most ${MAX_REQUIRED_OBSERVATIONS}`,
			subject: "required_observations",
		});
	}
	if (spec.progressDeadlineMs < spec.windowMs) {
		problems.push({
			code: "verification-deadline-before-window",
			message: `progress_deadline_ms ${spec.progressDeadlineMs} is shorter than window_ms ${spec.windowMs}`,
			subject: "progress_deadline_ms",
		});
	}
	if (
		!Number.isFinite(spec.maxErrorBudgetBurn) ||
		spec.maxErrorBudgetBurn < 0
	) {
		problems.push({
			code: "verification-spec-invalid",
			message: "max_error_budget_burn must be a finite number >= 0",
			subject: "max_error_budget_burn",
		});
	}
	if (
		spec.thresholds.length +
			spec.comparisons.length +
			spec.probes.length +
			spec.suites.length ===
		0
	) {
		problems.push({
			code: "verification-spec-empty",
			message: "the spec declares no checks",
			subject: "",
		});
	}

	const seen = new Set<string>();
	const unique = (id: string) => {
		if (seen.has(id))
			problems.push({
				code: "verification-duplicate-check",
				message: `${id} is declared twice`,
				subject: id,
			});
		seen.add(id);
	};

	spec.thresholds.forEach((threshold, index) => {
		const path = `thresholds[${index}]`;
		checkQuery(threshold.query, path, problems);
		if (threshold.query) unique(thresholdCheckId(threshold.query));
		if (
			threshold.aggregation === Aggregation.UNSPECIFIED ||
			!(threshold.aggregation in Aggregation)
		) {
			problems.push({
				code: "verification-spec-invalid",
				message: `${path}.aggregation is required`,
				subject: path,
			});
		}
		if (
			threshold.comparator === Comparator.UNSPECIFIED ||
			!(threshold.comparator in Comparator)
		) {
			problems.push({
				code: "verification-spec-invalid",
				message: `${path}.comparator is required`,
				subject: path,
			});
		}
		if (!Number.isFinite(threshold.value)) {
			problems.push({
				code: "verification-spec-invalid",
				message: `${path}.value must be finite`,
				subject: path,
			});
		}
	});

	spec.comparisons.forEach((comparison, index) => {
		const path = `comparisons[${index}]`;
		checkQuery(comparison.query, path, problems);
		if (comparison.query) {
			unique(comparisonCheckId(comparison.query));
			if (
				comparison.query.cohortLabel.trim() === "" &&
				comparison.query.source !== HealthSourceKind.HOBO_POSTURE
			) {
				problems.push({
					code: "verification-spec-invalid",
					message: `${path}.query.cohort_label is required`,
					subject: path,
				});
			}
		}
		if (
			comparison.direction !== Direction.HIGHER_IS_WORSE &&
			comparison.direction !== Direction.LOWER_IS_WORSE
		) {
			problems.push({
				code: "verification-spec-invalid",
				message: `${path}.direction is required`,
				subject: path,
			});
		}
		if (comparison.sensitivity === Sensitivity.UNSPECIFIED) {
			comparison.sensitivity =
				SENSITIVITY_DEFAULT[CD_DEFAULTS.verificationSensitivity] ??
				Sensitivity.MEDIUM;
		}
		if (comparison.minSamples === 0)
			comparison.minSamples = spec.requiredObservations;
	});

	spec.probes.forEach((probe, index) => {
		const path = `probes[${index}]`;
		if (!NAME.test(probe.name)) {
			problems.push({
				code: "verification-spec-invalid",
				message: `${path}.name must match ${NAME.source}`,
				subject: path,
			});
		}
		unique(probeCheckId(probe.name));
		if (!isHttpsUrl(probe.urlRef)) {
			problems.push({
				code: "verification-spec-invalid",
				message: `${path}.url_ref must be an https URL`,
				subject: path,
			});
		}
		if (probe.expectStatus === 0) probe.expectStatus = 200;
		if (probe.expectStatus < 100 || probe.expectStatus > 599) {
			problems.push({
				code: "verification-spec-invalid",
				message: `${path}.expect_status must be 100..599`,
				subject: path,
			});
		}
		if (probe.intervalMs === 0n) {
			const derived =
				spec.windowMs / BigInt(Math.max(1, spec.requiredObservations));
			probe.intervalMs = derived > 0n ? derived : 1n;
		}
		if (probe.intervalMs > spec.windowMs) {
			problems.push({
				code: "verification-probe-interval-exceeds-window",
				message: `${path}.interval_ms ${probe.intervalMs} exceeds window_ms ${spec.windowMs}`,
				subject: path,
			});
		}
		// Proto3 cannot tell "unset" from 0, and a ratio of 0 would pass every
		// probe; the conservative default is that every probe must succeed.
		if (probe.minSuccessRatio === 0) probe.minSuccessRatio = 1;
		if (!(probe.minSuccessRatio > 0 && probe.minSuccessRatio <= 1)) {
			problems.push({
				code: "verification-spec-invalid",
				message: `${path}.min_success_ratio must be in (0, 1]`,
				subject: path,
			});
		}
	});

	spec.suites.forEach((suite, index) => {
		const path = `suites[${index}]`;
		if (!NAME.test(suite.suite)) {
			problems.push({
				code: "verification-spec-invalid",
				message: `${path}.suite must match ${NAME.source}`,
				subject: path,
			});
		}
		unique(suiteCheckId(suite.suite));
	});

	if (spec.maxErrorBudgetBurn > 0) {
		const bound = [...spec.thresholds, ...spec.comparisons].some(
			(check) => check.query?.unit === BURN_RATE_UNIT,
		);
		if (!bound) {
			problems.push({
				code: "verification-error-budget-unbound",
				message: "max_error_budget_burn is set but no query has unit burn_rate",
				subject: "max_error_budget_burn",
			});
		}
	}

	if (problems.length > 0) {
		return {
			ok: false,
			reasons: problems.map((problem) =>
				reason(problem.code, problem.message, problem.subject),
			),
		};
	}
	// SAFETY: every constraint of the brand was checked above.
	return { ok: true, value: spec as ParsedVerificationSpec };
}

/**
 * Parse an authored spec document (protobuf JSON). Here an absent
 * `failOnNoData` is distinguishable from `false`, so it takes the D9 default
 * (true); unknown fields are refused rather than dropped.
 */
export function parseVerificationSpecJson(
	json: JsonValue,
): Outcome<ParsedVerificationSpec> {
	if (json === null || typeof json !== "object" || Array.isArray(json)) {
		return refuse(
			"verification-spec-invalid",
			"a verification spec must be a JSON object",
		);
	}
	let record: VerificationSpecRecord;
	try {
		record = fromJson(VerificationSpecRecordSchema, json);
	} catch (error) {
		return refuse(
			"verification-spec-invalid",
			error instanceof Error ? error.message : "unparseable verification spec",
		);
	}
	if (!("failOnNoData" in json) && !("fail_on_no_data" in json))
		record.failOnNoData = CD_DEFAULTS.verificationFailOnNoData;
	return parseVerificationSpec(record);
}
