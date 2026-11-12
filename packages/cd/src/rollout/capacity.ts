// Canary capacity: a canary, blue/green or experiment runs two versions side
// by side, so the second version's footprint is reserved through the shared
// hosting budget authority (@hobo/cloud) before any traffic moves. The budget
// authority stays the one budget ledger (no second one, §12); settlement of the
// reservation belongs to the hosting transition's SETTLE phase, keyed by the
// reservation id the rollout ledger records.
import type {
	HostingPlanCommitment,
	SharedHostingBudgetAuthority,
} from "@hobo/cloud";
import type { CampId, CdContext, Outcome, RolloutId } from "../ports.js";
import { refuse } from "./reasons.js";

export interface CanaryCapacity {
	reserve(
		input: Readonly<{ rolloutId: RolloutId; campId: CampId; percent: number }>,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ reservationId: string }>>>;
}

/** The priced commitment of running the candidate beside the stable version on one Camp. */
export type CanaryQuote = (
	input: Readonly<{ rolloutId: RolloutId; campId: CampId; percent: number }>,
) => Promise<Readonly<{ planHash: string; commitment: HostingPlanCommitment }> | undefined>;

/** Deterministic reservation id: one per rollout and Camp, so a retry never double-reserves. */
export function canaryReservationId(rolloutId: RolloutId, campId: CampId): string {
	return `canary:${rolloutId}:${campId}`;
}

export function canaryCapacityFromBudgetAuthority(
	authority: SharedHostingBudgetAuthority,
	quote: CanaryQuote,
): CanaryCapacity {
	return {
		async reserve(input) {
			const priced = await quote(input);
			if (!priced)
				return refuse(
					"canary-capacity-unavailable",
					`no hosting quote for the canary on Camp ${input.campId}`,
					input.campId,
				);
			const reservationId = canaryReservationId(input.rolloutId, input.campId);
			const result = await authority.reserve({
				reservationId,
				planHash: priced.planHash,
				commitment: priced.commitment,
			});
			return result.ok
				? { ok: true, value: { reservationId: result.reservationId } }
				: refuse("canary-capacity-unavailable", result.reason, input.campId);
		},
	};
}
