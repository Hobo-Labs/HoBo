// Per-Camp outcome rules (D21), pure. A Camp in flight is:
// - succeeded: its promotion qualified the Freight here and `min_success_ms`
//   has elapsed since, with the promotion not failed or rolled back;
// - failed: rejected, apply failure, verification FAIL/INCONCLUSIVE (the
//   promotion reports FAILED/ROLLED_BACK), or `progress_deadline_ms` elapsed;
// - deferred: its promotion was superseded by newer Freight (it catches up);
// - otherwise still in flight.
// Deferral at the Camp's turn (taint, unreachable, closed window) is decided
// by `eligibility`, before any promotion is requested.
import {
	CampConditionType,
	CampManagement,
	type CampStatusRecord,
	ConditionStatus,
	type PromotionRecord,
	PromotionState,
	type ReasonRecord,
	TaintEffect,
} from "../_generated/cd_pb.js";
import type { WindowEvaluation } from "../ports.js";
import { reason } from "./journal.js";
import { FANOUT_REASON } from "./policy.js";

export type Classification =
	| Readonly<{ kind: "in-flight" }>
	| Readonly<{ kind: "succeeded" }>
	| Readonly<{ kind: "failed"; reasons: readonly ReasonRecord[] }>
	| Readonly<{ kind: "deferred"; reasons: readonly ReasonRecord[] }>;

const FAILED_STATES: ReadonlySet<PromotionState> = new Set([
	PromotionState.REJECTED,
	PromotionState.FAILED,
	PromotionState.ROLLED_BACK,
]);

export function classify(
	input: Readonly<{
		campId: string;
		promotion: PromotionRecord | undefined;
		qualifiedAtMs: number | undefined;
		requestedAtMs: number;
		nowMs: number;
		minSuccessMs: number;
		progressDeadlineMs: number;
	}>,
): Classification {
	const { promotion, campId } = input;
	if (promotion !== undefined && FAILED_STATES.has(promotion.state)) {
		const state = PromotionState[promotion.state] ?? "FAILED";
		return {
			kind: "failed",
			reasons:
				promotion.reasons.length > 0
					? [...promotion.reasons]
					: [
							reason(
								FANOUT_REASON.promotionFailed,
								`promotion ${promotion.promotionId} for Camp ${campId} ended ${state}`,
								"inspect the promotion journal; fix the cause and promote newer Freight",
								campId,
							),
						],
		};
	}
	if (promotion?.state === PromotionState.SUPERSEDED) {
		return {
			kind: "deferred",
			reasons: [
				reason(
					FANOUT_REASON.superseded,
					`promotion ${promotion.promotionId} for Camp ${campId} was superseded by newer Freight`,
					"none: the Camp converges to the node's current qualified Freight",
					campId,
				),
			],
		};
	}
	if (
		input.qualifiedAtMs !== undefined &&
		input.nowMs >= input.qualifiedAtMs + input.minSuccessMs
	)
		return { kind: "succeeded" };
	if (
		input.qualifiedAtMs === undefined &&
		input.nowMs - input.requestedAtMs > input.progressDeadlineMs
	) {
		return {
			kind: "failed",
			reasons: [
				reason(
					FANOUT_REASON.progressDeadline,
					`Camp ${campId} did not qualify within ${input.progressDeadlineMs} ms`,
					"inspect the Camp's promotion and verification; raise progress_deadline_ms only if the rollout is legitimately slow",
					campId,
				),
			],
		};
	}
	return { kind: "in-flight" };
}

/** Why a Camp must be deferred at its turn, or undefined when it may start. */
export function eligibility(
	input: Readonly<{
		campId: string;
		status: CampStatusRecord | undefined;
		window: WindowEvaluation;
	}>,
): readonly ReasonRecord[] | undefined {
	const { campId, status } = input;
	if (status === undefined)
		return [
			reason(
				FANOUT_REASON.campStatusUnknown,
				`Camp ${campId} has no inventory status`,
				"wait for the Station or reconciler to report the Camp; it catches up when it does",
				campId,
			),
		];
	if (status.management !== CampManagement.MANAGED)
		return [
			reason(
				FANOUT_REASON.campNotManaged,
				`Camp ${campId} is not MANAGED`,
				"promote the Camp to MANAGED (camp.manage); it catches up afterwards",
				campId,
			),
		];
	const taint = status.taints.find(
		(item) =>
			item.effect === TaintEffect.NO_PLACE || item.effect === TaintEffect.NO_RUN,
	);
	if (taint !== undefined)
		return [
			reason(
				FANOUT_REASON.campTainted,
				`Camp ${campId} carries taint ${taint.key} (${TaintEffect[taint.effect] ?? "?"})`,
				"clear the cause (or untaint); the Camp catches up to the node's qualified Freight",
				campId,
			),
		];
	const reachable = status.conditions.find(
		(condition) => condition.type === CampConditionType.REACHABLE,
	);
	if (reachable?.status !== ConditionStatus.TRUE)
		return [
			reason(
				FANOUT_REASON.campUnreachable,
				`Camp ${campId} is not reachable`,
				"restore the Camp's reconciler connectivity; it catches up on reconnect",
				campId,
			),
		];
	if (!input.window.open)
		return [
			reason(
				FANOUT_REASON.windowClosed,
				`a change window is closed for Camp ${campId} (${input.window.activeFreezes.join(", ") || "no allow window open"})`,
				"wait for the window to open or record a governed window override",
				campId,
			),
		];
	return undefined;
}
