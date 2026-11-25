/**
 * Re-evaluating a recorded placement.
 *
 * `match.Decided` is a decision made once. Catalogs gain and lose offerings,
 * jurisdictions change, objectives change — and nothing revisited it, so a
 * placement that was right on Tuesday stayed recorded as right forever. That is
 * fine for a configuration tool and wrong for something that claims to *choose*
 * where workloads run.
 *
 * ## What this is, and what it deliberately is not
 *
 * This is not an optimizer. It answers one question — has an input changed such
 * that the decision might now differ, and are we permitted to act on it? — and
 * leaves the re-matching itself to the existing planner.
 *
 * Splitting it that way is what keeps re-placement explainable. The verdict
 * names the input that changed, so a workload that moves at 3am can say why.
 * A system that continuously re-optimizes and cannot answer that question is an
 * operational liability, and the event log is precisely the thing that lets
 * HoBo avoid it: the prior decision is carried forward, so the move is recorded
 * as a diff rather than as a replacement with no history.
 *
 * ## The three rules
 *
 * **No change, no churn.** Identical inputs hold. A re-evaluator that re-decides
 * on every tick is a workload shuffler wearing a cost-optimizer's clothes.
 *
 * **Residency outranks opportunity.** Moving to newer or cheaper capacity is a
 * jurisdiction decision (ADR-0146). A move that would land somewhere residency
 * forbids is `blocked` — never silently skipped, because a silent skip is how a
 * compliance problem becomes invisible.
 *
 * **Movement needs consent.** A workload that has not declared it tolerates
 * interruption is not moved for a mere improvement (ADR-0136's declared
 * effects and resilience are where that tolerance belongs). Being *forced* to
 * move is a different thing from being *able* to improve, and the two must not
 * collapse into one flag.
 *
 * ## Scope
 *
 * Price is not an input here. Cost-aware re-placement (ADR-0071) needs
 * multi-provider price data that HoBo does not yet have — tracked separately.
 * The mechanism is built so price joins as one more changed-input reason
 * without reshaping anything.
 */

/** The parts of a prior `match.Decided` that re-evaluation compares against. */
export interface PriorPlacement {
	readonly deploymentId: string;
	readonly resource: string;
	readonly region: string;
	readonly catalogContentHash: string;
	readonly objective: string;
}

export interface ReplacementInputs {
	readonly prior: PriorPlacement;
	/** The catalog hash as it stands now. */
	readonly catalogContentHash: string;
	/** The objective in force now. */
	readonly objective: string;
	/**
	 * Whether the prior region still satisfies residency.
	 *
	 * This is the *evaluated* result from `evaluateResidency`, reported by the
	 * caller — not an assumption made here. It defaults to satisfied because a
	 * caller that has not evaluated should not have its workload declared
	 * unlawful; a caller that has evaluated and found a violation must say so.
	 */
	readonly residencyOk?: boolean;
	/**
	 * Regions this workload may lawfully occupy. `undefined` means "not
	 * constrained here"; an empty array means "evaluated, and none qualify",
	 * which is a very different statement.
	 */
	readonly permittedRegions?: readonly string[];
	/**
	 * Whether the workload has declared it tolerates being interrupted. Defaults
	 * to false: silence is not consent to be moved.
	 */
	readonly interruptible?: boolean;
}

export type ReplacementReason =
	| "catalog-changed"
	| "objective-changed"
	| "residency-violated"
	| "no-permitted-region";

/**
 * - `hold` — leave the placement alone.
 * - `re-decide` — hand the planner a fresh match for this resource.
 * - `blocked` — a move is needed or wanted but cannot lawfully happen.
 */
export type ReplacementAction = "hold" | "re-decide" | "blocked";

export interface ReplacementVerdict {
	readonly action: ReplacementAction;
	/** Every input that differs, named. Sorted, so the verdict is stable. */
	readonly reasons: readonly ReplacementReason[];
	/** The decision this verdict is measured against. */
	readonly prior: PriorPlacement;
	/** True when the current placement has become invalid, not merely improvable. */
	readonly forced: boolean;
	/**
	 * True when a real opportunity exists but was not acted on — today only
	 * because the workload has not consented to interruption. Surfacing it
	 * without acting is the point: an operator can see the opportunity and
	 * choose, which is better than silence in either direction.
	 */
	readonly deferred: boolean;
}

export function evaluateReplacement(
	input: ReplacementInputs,
): ReplacementVerdict {
	const reasons: ReplacementReason[] = [];

	const residencyOk = input.residencyOk ?? true;
	if (!residencyOk) reasons.push("residency-violated");

	if (input.catalogContentHash !== input.prior.catalogContentHash)
		reasons.push("catalog-changed");
	if (input.objective !== input.prior.objective)
		reasons.push("objective-changed");

	const forced = !residencyOk;
	const opportunity = reasons.some(
		(reason) => reason === "catalog-changed" || reason === "objective-changed",
	);

	// `undefined` means unconstrained; an empty array means evaluated-and-none.
	// Collapsing those two would turn "we did not check" into "nowhere is legal".
	const nowhereLawful =
		input.permittedRegions !== undefined && input.permittedRegions.length === 0;

	let action: ReplacementAction;
	let deferred = false;

	if (forced || opportunity) {
		if (nowhereLawful) {
			reasons.push("no-permitted-region");
			action = "blocked";
		} else if (forced) {
			// A placement that has become unlawful must move. Consent to
			// interruption is irrelevant: staying is not an option on offer.
			action = "re-decide";
		} else if (input.interruptible === true) {
			action = "re-decide";
		} else {
			// The opportunity is real and stays named in `reasons`, so it can be
			// reported without being acted on.
			action = "hold";
			deferred = true;
		}
	} else {
		action = "hold";
	}

	reasons.sort();

	return {
		action,
		reasons,
		prior: input.prior,
		forced,
		deferred,
	};
}
