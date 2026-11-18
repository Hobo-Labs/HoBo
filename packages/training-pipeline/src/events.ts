import {
	type PromotionDecision,
	PromotionOutcome,
} from "./_generated/promotion_decision_pb.js";

// public-contract: training-run promotion fact (event-families.md training.*).
const TRAINING_PROMOTED = "training.Promoted";
// public-contract: generated-impl promotion fact (event-families.md impl.*).
const IMPL_PROMOTED = "impl.Promoted";
// public-contract: eval-gate refusal fact (event-families.md eval.*).
const EVAL_GATE_FAILED = "eval.GateFailed";

/**
 * The past-tense event names a promotion decision emits: a promote publishes
 * both the training-run and generated-impl promotion facts; a refusal
 * publishes the eval-gate failure. The decision is the source of truth, so the
 * mapping is total over its outcome.
 */
export function promotionEventNames(
	decision: PromotionDecision,
): readonly string[] {
	switch (decision.outcome) {
		case PromotionOutcome.PROMOTE:
			return [TRAINING_PROMOTED, IMPL_PROMOTED];
		case PromotionOutcome.REFUSE:
			return [EVAL_GATE_FAILED];
		default:
			return [];
	}
}
