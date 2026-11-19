import {
	type PromotionDecision,
	PromotionOutcome,
} from "./_generated/promotion_decision_pb.js";

const TRAINING_PROMOTED = "training.Promoted";
const IMPL_PROMOTED = "impl.Promoted";
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
