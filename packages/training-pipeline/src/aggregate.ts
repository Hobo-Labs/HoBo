import { create } from "@bufbuild/protobuf";
import { diagnosticJson } from "@hobo/core";
import {
	type EvalResult,
	EvalResultSchema,
} from "./_generated/promotion_decision_pb.js";
import { PromotionGateParseError } from "./gate.js";

export interface GradedSample {
	readonly scores: Readonly<Record<string, number>>;
}

export interface AggregateEvalOptions {
	readonly rubricRef: string;
	readonly source: string;
}

export function aggregateEvalResults(
	samples: readonly GradedSample[],
	options: AggregateEvalOptions,
): EvalResult {
	if (samples.length === 0) {
		throw new PromotionGateParseError(
			"samples",
			"at least one graded trajectory",
			diagnosticJson(samples),
		);
	}

	const sums = new Map<string, { total: number; count: number }>();
	for (const [index, sample] of samples.entries()) {
		for (const [metric, score] of Object.entries(sample.scores)) {
			if (!Number.isFinite(score) || score < 0 || score > 1) {
				throw new PromotionGateParseError(
					`samples.${index}.scores.${metric}`,
					"number in [0, 1]",
					score,
				);
			}
			const entry = sums.get(metric) ?? { total: 0, count: 0 };
			entry.total += score;
			entry.count += 1;
			sums.set(metric, entry);
		}
	}

	const scores = Object.fromEntries(
		[...sums.entries()]
			.map(([metric, { total, count }]) => [metric, total / count] as const)
			.sort(([left], [right]) => left.localeCompare(right)),
	);

	return Object.freeze(
		create(EvalResultSchema, {
			rubricRef: options.rubricRef,
			scores,
			sampleCount: samples.length,
			source: options.source,
		}),
	);
}
