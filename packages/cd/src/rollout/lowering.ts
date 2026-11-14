// D7 lowering: a progressive strategy is lowered per Camp onto the traffic
// offerings its provider declares, ranked edge.canary → lb.weighted →
// dns.weighted → inprocess.weighted. The chosen rung (and every rung skipped
// above it) is recorded in rollout.Lowered. Nothing is ever downgraded
// silently: a progressive strategy with no realizable rung, or with a fallback
// that policy forbids, is refused with `progressive-unsupported` (I6).
//
// Everything here is pure: no clock, network or RNG (I8).
import { create } from "@bufbuild/protobuf";
import type { TrafficRoutingOfferingId } from "@hobo/core";
import {
	type ObligationRef,
	type ReasonRecord,
	type RolloutLoweringRecord,
	RolloutLoweringRecordSchema,
	RolloutStrategy,
} from "../_generated/cd_pb.js";
import { CD_RAMP_DEFAULTS, PROGRESSIVE_UNSUPPORTED } from "../events.js";
import type { CampId, Outcome } from "../ports.js";
import { reason, refuse } from "./reasons.js";

// public-contract: the D7 traffic rung ladder, best first.
export const TRAFFIC_LADDER: readonly TrafficRoutingOfferingId[] =
	Object.freeze([
		"edge.canary",
		"lb.weighted",
		"dns.weighted",
		"inprocess.weighted",
	]);

// public-contract: obligation kinds the orchestrator honours (set by the gate).
export const ROLLOUT_OBLIGATIONS = Object.freeze({
	/** Policy forbids any rung below the first (edge.canary). */
	noFallback: "rollout.no-fallback",
	/** Every stage boundary needs an approval through the ApprovalPort. */
	stageApproval: "rollout.stage-approval",
	/** Canary capacity must be reserved through the hosting budget authority. */
	hostingBudget: "hosting-budget",
	/** Names the experiment an EXPERIMENT rollout holds on (obligation id). */
	experiment: "experiment",
} as const);

/** UNSPECIFIED lowers to CANARY: the smallest blast radius, never a silent all-at-once. */
export function effectiveStrategy(strategy: RolloutStrategy): RolloutStrategy {
	return strategy === RolloutStrategy.UNSPECIFIED
		? RolloutStrategy.CANARY
		: strategy;
}

/** Strategies that run two versions side by side and so need a traffic rung. */
export function needsTraffic(strategy: RolloutStrategy): boolean {
	return (
		strategy === RolloutStrategy.CANARY ||
		strategy === RolloutStrategy.BLUE_GREEN ||
		strategy === RolloutStrategy.EXPERIMENT
	);
}

/** Canary-vs-baseline comparisons are meaningful only while traffic is split. */
export function cohortAware(
	strategy: RolloutStrategy,
	percent: number,
): boolean {
	return (
		percent < 100 &&
		(strategy === RolloutStrategy.CANARY ||
			strategy === RolloutStrategy.EXPERIMENT)
	);
}

export function hasObligation(
	obligations: readonly ObligationRef[],
	kind: string,
): boolean {
	return obligations.some((obligation) => obligation.kind === kind);
}

function defaultsFor(strategy: RolloutStrategy): readonly number[] {
	if (strategy === RolloutStrategy.BLUE_GREEN)
		return CD_RAMP_DEFAULTS.blueGreen;
	if (strategy === RolloutStrategy.EXPERIMENT)
		return CD_RAMP_DEFAULTS.experiment;
	if (strategy === RolloutStrategy.CANARY) return CD_RAMP_DEFAULTS.canary;
	return [100];
}

/**
 * Stage percents for a strategy. Empty input takes CD_RAMP_DEFAULTS. A
 * progressive ramp that stops short of 100 gets a final 100 stage, so every
 * rollout ends fully shifted and verified (an experiment holds at its last
 * split until concluded, then goes to 100).
 */
export function stagePercentsFor(
	strategy: RolloutStrategy,
	requested: readonly number[],
): Outcome<readonly number[]> {
	const fixed =
		strategy === RolloutStrategy.ALL_AT_ONCE ||
		strategy === RolloutStrategy.BLUE_GREEN;
	const base = requested.length === 0 ? defaultsFor(strategy) : requested;
	const ascending = base.every(
		(percent, index) =>
			Number.isInteger(percent) &&
			percent > 0 &&
			percent <= 100 &&
			percent > (base[index - 1] ?? 0),
	);
	if (!ascending || (fixed && (base.length !== 1 || base[0] !== 100)))
		return refuse(
			"rollout-stages-invalid",
			`stage percents [${base.join(", ")}] are not valid for this strategy`,
		);
	const last = base.at(-1) ?? 100;
	return {
		ok: true,
		value: Object.freeze(last === 100 ? [...base] : [...base, 100]),
	};
}

/** Lower one Camp: pick the best realizable rung, or record a refusal. */
export function lowerCamp(
	input: Readonly<{
		campId: CampId;
		strategy: RolloutStrategy;
		offerings: readonly TrafficRoutingOfferingId[];
		fallbackForbidden: boolean;
	}>,
): RolloutLoweringRecord {
	const record = (
		offeringId = "",
		fallbackFrom: readonly string[] = [],
		refusal?: ReasonRecord,
	) =>
		create(RolloutLoweringRecordSchema, {
			campId: input.campId,
			strategy: input.strategy,
			offeringId,
			fallbackFrom: [...fallbackFrom],
			...(refusal === undefined ? undefined : { refusal }),
		});
	if (!needsTraffic(input.strategy)) return record();
	const available = new Set(input.offerings);
	const rung = TRAFFIC_LADDER.findIndex((offering) => available.has(offering));
	if (rung < 0)
		return record(
			"",
			[],
			reason(
				PROGRESSIVE_UNSUPPORTED,
				`no traffic rung realizes ${RolloutStrategy[input.strategy]} on Camp ${input.campId} (declared: ${[...input.offerings].sort().join(", ") || "none"})`,
				input.campId,
			),
		);
	const skipped = TRAFFIC_LADDER.slice(0, rung);
	const offeringId = TRAFFIC_LADDER[rung] ?? "";
	if (rung > 0 && input.fallbackForbidden)
		return record(
			"",
			skipped,
			reason(
				PROGRESSIVE_UNSUPPORTED,
				`policy forbids falling back from ${skipped.join(", ")} to ${offeringId} on Camp ${input.campId}`,
				input.campId,
			),
		);
	return record(offeringId, skipped);
}
