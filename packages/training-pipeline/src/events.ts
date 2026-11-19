import {
	type PromotionDecision,
	PromotionOutcome,
} from "./_generated/promotion_decision_pb.js";

// strings, so each carries a public-contract marker.

// public-contract: training-run promotion fact (event-families.md training.*).
const TRAINING_PROMOTED = "training.Promoted";
// public-contract: generated-impl promotion fact (event-families.md impl.*).
const IMPL_PROMOTED = "impl.Promoted";
// public-contract: eval-gate refusal fact (event-families.md eval.*).
const EVAL_GATE_FAILED = "eval.GateFailed";

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
