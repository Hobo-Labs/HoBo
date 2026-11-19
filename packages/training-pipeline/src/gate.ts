import type { DescMessage, JsonValue } from "@bufbuild/protobuf";
import { create, fromJson } from "@bufbuild/protobuf";
import { CoreParseError, diagnosticJson } from "@hobo/core";
import {
	type EvalResult,
	EvalResultSchema,
	type PromotionDecision,
	PromotionDecisionSchema,
	PromotionOutcome,
	type PromotionThresholds,
	PromotionThresholdsSchema,
} from "./_generated/promotion_decision_pb.js";

export type {
	ChampionChallenger,
	EvalResult,
	LensFlags,
	PromotionDecision,
	PromotionThresholds,
} from "./_generated/promotion_decision_pb.js";
export { PromotionOutcome } from "./_generated/promotion_decision_pb.js";

export class PromotionGateParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_TRAINING_PROMOTION_PARSE", path, expected, received, message);
		this.name = "PromotionGateParseError";
	}
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
function fail(path: string, expected: string, received: unknown): never {
	throw new PromotionGateParseError(path, expected, diagnosticJson(received));
}

function nonEmpty(value: string, path: string): string {
	if (value.trim().length === 0) fail(path, "non-empty string", value);
	return value;
}

function unitInterval(value: number, path: string): number {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		fail(path, "number in [0, 1]", value);
	}
	return value;
}

function fromJsonOrFail<Schema extends DescMessage>(
	schema: Schema,
	// oxlint-disable-next-line anti-slop/no-unknown-parameters
	value: unknown,
	path: string,
): ReturnType<typeof fromJson<Schema>> {
	try {
		return fromJson(schema, value as JsonValue);
	} catch (error) {
		fail(path, schema.typeName, error instanceof Error ? error.message : error);
	}
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function parseEvalResult(value: unknown): EvalResult {
	const result = fromJsonOrFail(EvalResultSchema, value, "evalResult");
	nonEmpty(result.rubricRef, "evalResult.rubricRef");
	nonEmpty(result.source, "evalResult.source");
	for (const [metric, score] of Object.entries(result.scores)) {
		unitInterval(score, `evalResult.scores.${metric}`);
	}
	for (const [metric, count] of Object.entries(result.metricSampleCounts)) {
		if (
			!Object.hasOwn(result.scores, metric) ||
			!Number.isSafeInteger(count) ||
			count < 1 ||
			count > result.sampleCount
		) {
			fail(
				`evalResult.metricSampleCounts.${metric}`,
				"a reported metric count between 1 and sampleCount",
				count,
			);
		}
	}
	Object.freeze(result.scores);
	Object.freeze(result.metricSampleCounts);
	return Object.freeze(result);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function parsePromotionThresholds(value: unknown): PromotionThresholds {
	const thresholds = fromJsonOrFail(
		PromotionThresholdsSchema,
		value,
		"promotionThresholds",
	);
	for (const [metric, floor] of Object.entries(thresholds.metricFloors)) {
		unitInterval(floor, `promotionThresholds.metricFloors.${metric}`);
	}
	Object.freeze(thresholds.metricFloors);
	return Object.freeze(thresholds);
}

export interface PromotionGateInput {
	readonly candidateId: string;
	readonly conformance: boolean;
	readonly policy: boolean;
	readonly evalResult: EvalResult;
	readonly thresholds: PromotionThresholds;
	readonly championId?: string;
}

export function evaluatePromotionGate(
	input: PromotionGateInput,
): PromotionDecision {
	nonEmpty(input.candidateId, "candidateId");
	const failures: string[] = [];

	if (!input.conformance) {
		failures.push("conformance: hard contract not green");
	}

	if (input.evalResult.sampleCount < input.thresholds.minSamples) {
		failures.push(
			`eval: ${input.evalResult.sampleCount} samples below min ${input.thresholds.minSamples}`,
		);
	}
	for (const [metric, floor] of Object.entries(input.thresholds.metricFloors)) {
		const score = input.evalResult.scores[metric];
		if (score === undefined) {
			failures.push(`eval: metric ${metric} missing from eval result`);
			continue;
		}
		const count = input.evalResult.metricSampleCounts?.[metric];
		if (
			count === undefined ||
			!Number.isSafeInteger(count) ||
			count < 1 ||
			count > input.evalResult.sampleCount
		) {
			failures.push(`eval: metric ${metric} has no valid sample count`);
		} else if (count < input.thresholds.minSamples) {
			failures.push(
				`eval: metric ${metric} has ${count} ${count === 1 ? "sample" : "samples"} below min ${input.thresholds.minSamples}`,
			);
		}
		if (score < floor) {
			failures.push(`eval: ${metric} ${score} below floor ${floor}`);
		}
	}

	if (!input.policy) {
		failures.push("policy: promotion not allowed by policy");
	}

	const evalPassed = !failures.some((failure) => failure.startsWith("eval:"));
	const promoted = failures.length === 0;

	const decision = create(PromotionDecisionSchema, {
		candidateId: input.candidateId,
		outcome: promoted ? PromotionOutcome.PROMOTE : PromotionOutcome.REFUSE,
		passed: {
			conformance: input.conformance,
			eval: evalPassed,
			policy: input.policy,
		},
		failures,
		championChallenger: {
			championId: input.championId ?? "",
			challengerId: input.candidateId,
		},
	});
	Object.freeze(decision.failures);
	if (decision.passed) Object.freeze(decision.passed);
	if (decision.championChallenger) Object.freeze(decision.championChallenger);
	return Object.freeze(decision);
}
