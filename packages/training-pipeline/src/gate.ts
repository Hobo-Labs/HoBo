import type { JsonValue } from "@bufbuild/protobuf";
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

// The champion/challenger promotion gate (ADR-0025 / ADR-0125, IMPL-003).
// A candidate promotes only through the same three-lens gate as any
// generation-pipeline impl: conformance (hard contract) green AND eval
// thresholds met over enough samples AND policy allows. The Trace lens rides
// the event log, so it is not a flag here. Record shapes are the generated
// protobuf types (data-models/promotion_decision.proto); this module adds the
// decision function, its boundary parsers, and the CUE-mirrored invariants.

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

function fromJsonOrFail<T>(
	schema: Parameters<typeof fromJson>[0],
	value: unknown,
	path: string,
): T {
	try {
		return fromJson(schema, value as JsonValue) as T;
	} catch (error) {
		fail(path, schema.typeName, error instanceof Error ? error.message : error);
	}
}

function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const nested of Object.values(value)) freeze(nested);
		Object.freeze(value);
	}
	return value;
}

/** Parses a live-eval / held-out / adversarial rubric score. */
export function parseEvalResult(value: unknown): EvalResult {
	const result = fromJsonOrFail<EvalResult>(
		EvalResultSchema,
		value,
		"evalResult",
	);
	nonEmpty(result.rubricRef, "evalResult.rubricRef");
	nonEmpty(result.source, "evalResult.source");
	for (const [metric, score] of Object.entries(result.scores)) {
		unitInterval(score, `evalResult.scores.${metric}`);
	}
	return freeze(result);
}

/** Parses the metric floors and min-samples gate configuration. */
export function parsePromotionThresholds(value: unknown): PromotionThresholds {
	const thresholds = fromJsonOrFail<PromotionThresholds>(
		PromotionThresholdsSchema,
		value,
		"promotionThresholds",
	);
	for (const [metric, floor] of Object.entries(thresholds.metricFloors)) {
		unitInterval(floor, `promotionThresholds.metricFloors.${metric}`);
	}
	return freeze(thresholds);
}

export interface PromotionGateInput {
	readonly candidateId: string;
	/** Conformance lens: the hard contract (PACT/conformance) is green. */
	readonly conformance: boolean;
	/** Policy lens: tenant/Camp policy allows the promotion. */
	readonly policy: boolean;
	readonly evalResult: EvalResult;
	readonly thresholds: PromotionThresholds;
	readonly championId?: string;
}

/**
 * The three-lens promotion decision. A challenger promotes over the champion
 * only when conformance is green, every metric floor is met over at least the
 * minimum sample count, and policy allows; otherwise it is refused with the
 * failing lenses recorded.
 */
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
		} else if (score < floor) {
			failures.push(`eval: ${metric} ${score} below floor ${floor}`);
		}
	}

	if (!input.policy) {
		failures.push("policy: promotion not allowed by policy");
	}

	const evalPassed = !failures.some((failure) => failure.startsWith("eval:"));
	const promoted = failures.length === 0;

	return freeze(
		create(PromotionDecisionSchema, {
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
		}),
	);
}
