import * as Schema from "effect/Schema";
import { compareCodeUnits } from "../order.js";
import {
	decodeNonNegativeMicros,
	decodeNonNegativeUnits,
	DispatchCategory,
	NonNegativeMicros,
	NonNegativeSlots,
	NonNegativeUnits,
	PositiveUnits,
	ProviderId,
	ScopedAccountId,
	scopedAccountId,
} from "./ids.js";

export const DispatchCandidateSnapshot = Schema.Struct({
	accountId: ScopedAccountId,
	category: DispatchCategory,
	providerId: ProviderId,
	listUnitMicros: NonNegativeMicros,
	switchingMicros: NonNegativeMicros,
	freeHeadroom: NonNegativeUnits,
	rateHeadroom: NonNegativeUnits,
	concurrencyHeadroom: NonNegativeSlots,
	budgetCapMicros: Schema.NullOr(NonNegativeMicros),
	spentMicros: NonNegativeMicros,
	heldMicros: NonNegativeMicros,
});
export type DispatchCandidateSnapshot = typeof DispatchCandidateSnapshot.Type;

export const CandidateExclusionReason = Schema.Literals([
	"category-mismatch",
	"account-scope-mismatch",
	"insufficient-rate-headroom",
	"insufficient-concurrency-headroom",
	"budget-cap-exceeded",
]);
export type CandidateExclusionReason = typeof CandidateExclusionReason.Type;

export const RankedEligibleCandidate = Schema.TaggedStruct("Eligible", {
	accountId: ScopedAccountId,
	providerId: ProviderId,
	freeUnitsUsed: NonNegativeUnits,
	paidUnits: NonNegativeUnits,
	requiredMicros: NonNegativeMicros,
});
export type RankedEligibleCandidate = typeof RankedEligibleCandidate.Type;

export const RankedExcludedCandidate = Schema.TaggedStruct("Excluded", {
	accountId: ScopedAccountId,
	providerId: ProviderId,
	reason: CandidateExclusionReason,
});
export type RankedExcludedCandidate = typeof RankedExcludedCandidate.Type;

export const SelectedDispatchCandidate = Schema.TaggedStruct("Selected", {
	category: DispatchCategory,
	winner: RankedEligibleCandidate,
	eligible: Schema.NonEmptyArray(RankedEligibleCandidate),
	excluded: Schema.Array(RankedExcludedCandidate),
});
export type SelectedDispatchCandidate = typeof SelectedDispatchCandidate.Type;

export const NoEligibleDispatchCandidate = Schema.TaggedStruct("NoEligible", {
	category: DispatchCategory,
	excluded: Schema.Array(RankedExcludedCandidate),
});
export type NoEligibleDispatchCandidate = typeof NoEligibleDispatchCandidate.Type;

export const DispatchSelectionOutcome = Schema.Union([
	SelectedDispatchCandidate,
	NoEligibleDispatchCandidate,
]);
export type DispatchSelectionOutcome = typeof DispatchSelectionOutcome.Type;

export interface DispatchSelectionRequest {
	readonly category: DispatchCategory;
	readonly units: PositiveUnits;
	readonly estimatedMicros: NonNegativeMicros;
	readonly incumbentProviderId?: ProviderId;
	readonly candidates: readonly DispatchCandidateSnapshot[];
}

export function selectDispatchCandidate(
	request: DispatchSelectionRequest,
): DispatchSelectionOutcome {
	const eligible: RankedEligibleCandidate[] = [];
	const excluded: RankedExcludedCandidate[] = [];

	for (const candidate of request.candidates) {
		if (candidate.category !== request.category) {
			excluded.push({
				_tag: "Excluded",
				accountId: candidate.accountId,
				providerId: candidate.providerId,
				reason: "category-mismatch",
			});
			continue;
		}
		const expectedAccountId = scopedAccountId(
			request.category,
			candidate.providerId,
		);
		if (candidate.accountId !== expectedAccountId) {
			excluded.push({
				_tag: "Excluded",
				accountId: candidate.accountId,
				providerId: candidate.providerId,
				reason: "account-scope-mismatch",
			});
			continue;
		}
		if (candidate.rateHeadroom < request.units) {
			excluded.push({
				_tag: "Excluded",
				accountId: candidate.accountId,
				providerId: candidate.providerId,
				reason: "insufficient-rate-headroom",
			});
			continue;
		}
		if (candidate.concurrencyHeadroom < 1) {
			excluded.push({
				_tag: "Excluded",
				accountId: candidate.accountId,
				providerId: candidate.providerId,
				reason: "insufficient-concurrency-headroom",
			});
			continue;
		}

		const freeUnitsUsed = Math.min(candidate.freeHeadroom, request.units);
		const paidUnits = request.units - freeUnitsUsed;
		const switchingCost =
			request.incumbentProviderId === candidate.providerId
				? 0
				: candidate.switchingMicros;
		const computedMicros =
			paidUnits * candidate.listUnitMicros + switchingCost;
		const requiredMicros = Math.max(computedMicros, request.estimatedMicros);

		if (
			candidate.budgetCapMicros !== null &&
			candidate.spentMicros + candidate.heldMicros + requiredMicros >
				candidate.budgetCapMicros
		) {
			excluded.push({
				_tag: "Excluded",
				accountId: candidate.accountId,
				providerId: candidate.providerId,
				reason: "budget-cap-exceeded",
			});
			continue;
		}

		eligible.push({
			_tag: "Eligible",
			accountId: candidate.accountId,
			providerId: candidate.providerId,
			freeUnitsUsed: decodeNonNegativeUnits(freeUnitsUsed),
			paidUnits: decodeNonNegativeUnits(paidUnits),
			requiredMicros: decodeNonNegativeMicros(requiredMicros),
		});
	}

	eligible.sort(
		(left, right) =>
			left.requiredMicros - right.requiredMicros ||
			right.freeUnitsUsed - left.freeUnitsUsed ||
			compareCodeUnits(left.providerId, right.providerId),
	);

	excluded.sort(
		(left, right) =>
			compareCodeUnits(left.providerId, right.providerId) ||
			compareCodeUnits(left.accountId, right.accountId) ||
			compareCodeUnits(left.reason, right.reason),
	);

	const [winner, ...rest] = eligible;
	if (winner === undefined) {
		return {
			_tag: "NoEligible",
			category: request.category,
			excluded,
		};
	}

	return {
		_tag: "Selected",
		category: request.category,
		winner,
		eligible: [winner, ...rest],
		excluded,
	};
}
