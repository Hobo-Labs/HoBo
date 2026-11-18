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

export type CanaryQuote = (
	input: Readonly<{ rolloutId: RolloutId; campId: CampId; percent: number }>,
) => Promise<
	Readonly<{ planHash: string; commitment: HostingPlanCommitment }> | undefined
>;

export function canaryReservationId(
	rolloutId: RolloutId,
	campId: CampId,
): string {
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
