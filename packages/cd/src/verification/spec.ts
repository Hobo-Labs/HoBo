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
import { isJsonObject } from "./json.js";
import { reason, refuse, type VerificationReasonCode } from "./reasons.js";

export type ParsedVerificationSpec = VerificationSpecRecord & {
	readonly __brand: "cd.ParsedVerificationSpec";
};

export const BURN_RATE_UNIT = "burn_rate";
export const RATIO_UNIT = "ratio";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_QUERY_CHARS = 4096;
const PROMETHEUS_RECORDING_RULE =
	/^[A-Za-z_:][A-Za-z0-9_:]*(?:\{(?:[^{}"\\]|"(?:[^"\\]|\\.)*")*\})?$/u;
const MAX_REQUIRED_OBSERVATIONS = 10_000;
const MAX_WINDOW_MS = 7n * 24n * 3_600_000n;
function defaultSensitivity(): Sensitivity {
	switch (CD_DEFAULTS.verificationSensitivity) {
		case "MEDIUM":
			return Sensitivity.MEDIUM;
	}
}

export const thresholdCheckId = (query: HealthQueryRecord) =>
	`threshold:${query.name}`;
export const comparisonCheckId = (query: HealthQueryRecord) =>
	`comparison:${query.name}`;
export const probeCheckId = (name: string) => `probe:${name}`;
export const suiteCheckId = (suite: string) => `suite:${suite}`;
export const ERROR_BUDGET_CHECK = "error-budget";
export const SLO_CHECK = "slo:gate";
export const SLO_BURN_CHECK = "slo:burn";
export const SLO_BUDGET_CHECK = "slo:budget";
export const SLO_BURN_TIME_BEFORE_CHECK = "slo:burn-time-before";
export const SLO_BURN_TIME_AFTER_CHECK = "slo:burn-time-after";
export const SLO_BUDGET_TIME_BEFORE_CHECK = "slo:budget-time-before";
export const SLO_BUDGET_TIME_AFTER_CHECK = "slo:budget-time-after";

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

export function parseVerificationSpec(
	input: VerificationSpecRecord,
): Outcome<ParsedVerificationSpec> {
	const spec = clone(VerificationSpecRecordSchema, input);
	const problems: Problem[] = [];

	if (spec.windowMs === 0n)
		spec.windowMs = BigInt(
			spec.sloGate ? 900_000 : CD_DEFAULTS.verificationWindowMs,
		);
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
			spec.suites.length +
			(spec.sloGate ? 1 : 0) ===
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
			comparison.sensitivity = defaultSensitivity();
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

	if (spec.sloGate) {
		const gate = spec.sloGate;
		gate.rollbackBurnRate ??= 12;
		gate.minRemainingBudgetRatio ??= 0.08;
		gate.holdBurnRate ??= 1;
		gate.holdRemainingBudgetRatio ??= 0.2;
		if (gate.sustainedBreachCount === 0) gate.sustainedBreachCount = 2;
		if (gate.sustainedHealthyCount === 0) gate.sustainedHealthyCount = 2;
		if (gate.maxSampleAgeMs === 0n)
			gate.maxSampleAgeMs = spec.windowMs < 600_000n ? spec.windowMs : 600_000n;
		checkQuery(gate.burnRate, "slo_gate.burn_rate", problems);
		checkQuery(
			gate.remainingBudgetRatio,
			"slo_gate.remaining_budget_ratio",
			problems,
		);
		for (const [query, path] of [
			[gate.burnRate, "slo_gate.burn_rate"],
			[gate.remainingBudgetRatio, "slo_gate.remaining_budget_ratio"],
		] as const) {
			if (
				query?.source === HealthSourceKind.PROMETHEUS &&
				!PROMETHEUS_RECORDING_RULE.test(query.query)
			) {
				problems.push({
					code: "verification-spec-invalid",
					message: `${path}.query must select a Prometheus recording rule directly`,
					subject: path,
				});
			}
		}
		if (
			gate.burnRate?.unit !== BURN_RATE_UNIT ||
			gate.remainingBudgetRatio?.unit !== RATIO_UNIT
		)
			problems.push({
				code: "verification-spec-invalid",
				message: "SLO queries require burn_rate and ratio units",
				subject: "slo_gate",
			});
		if (
			!Number.isFinite(gate.rollbackBurnRate) ||
			!Number.isFinite(gate.holdBurnRate) ||
			gate.holdBurnRate <= 0 ||
			gate.rollbackBurnRate <= gate.holdBurnRate ||
			!Number.isFinite(gate.minRemainingBudgetRatio) ||
			!Number.isFinite(gate.holdRemainingBudgetRatio) ||
			gate.minRemainingBudgetRatio < 0 ||
			gate.holdRemainingBudgetRatio > 1 ||
			gate.minRemainingBudgetRatio >= gate.holdRemainingBudgetRatio
		)
			problems.push({
				code: "verification-spec-invalid",
				message: "SLO hold and rollback thresholds must be finite and ordered",
				subject: "slo_gate",
			});
		if (
			gate.sustainedBreachCount < 2 ||
			gate.sustainedBreachCount > MAX_REQUIRED_OBSERVATIONS ||
			gate.sustainedHealthyCount < 2 ||
			gate.sustainedHealthyCount > MAX_REQUIRED_OBSERVATIONS ||
			gate.maxSampleAgeMs > spec.windowMs
		)
			problems.push({
				code: "verification-spec-invalid",
				message:
					"SLO sample counts must be 2..10000 and sample age must fit the window",
				subject: "slo_gate",
			});
	}

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
	return { ok: true, value: spec as ParsedVerificationSpec };
}

export function parseVerificationSpecJson(
	json: JsonValue,
): Outcome<ParsedVerificationSpec> {
	if (!isJsonObject(json)) {
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
