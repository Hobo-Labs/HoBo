/**
 * Budget routing: which member of a fleet of interchangeable, loss-tolerant
 * backends should be active, by preference and allowance.
 *
 * `decideFleet` (`policy.ts`) moves only when the writer is in trouble, and it
 * judges a standby by its copy lag, because a database fleet's standbys hold
 * the data. A fleet whose state may be lost (a cache: everything in it is
 * rebuilt by name after a move) has no lag to judge and a second reason to
 * move: a cheaper member is available. `routeFleetByBudget` decides that, and
 * is as pure as `decideFleet`: no clock, no I/O, one answer with its reasons
 * and every member ranked.
 *
 * - **Preference.** Free, then prepaid, then pay-as-you-go; within a tier the
 *   cheaper projected month, then the configured order.
 * - **Before exhaustion, with hysteresis.** The active member stays while its
 *   projected month is below `switchAt` of every allowance it would stop at
 *   (a hard stop or an unknown overage). Any other member is a candidate only
 *   below `switchBackBelow`. A member that was left because it neared its
 *   allowance is therefore not chosen again until its projection falls under
 *   the lower mark, which within one month it does not (its use so far is
 *   spent), so it comes back at the next month at the earliest.
 * - **Budget caps.** A member's projected cost (its fee plus metered use beyond
 *   its allowance) must stay within its cap. No cap means no money: only a
 *   member whose projected cost is zero is affordable.
 * - **Failover.** A member that has failed for longer than `failoverAfterMs`
 *   is left for the best reachable member that is affordable and not
 *   projected past a hard stop, whatever the marks say: a relay that is down
 *   costs more than a move.
 * - **Unknown is not a reason.** A member with no financial model, or with a
 *   fact missing, is never moved to for budget reasons and never left for
 *   them; it may still be the target of a failover.
 *
 * Projection: the fleet's workload this period, per unit, divided by the time
 * elapsed gives a rate; a member's projected month is what it has already
 * spent this period plus that rate over the time remaining. The workload in a
 * unit a member does not run on is the host's estimate (a cache relay converts
 * port calls with each binding's cost table).
 */
import {
	type AssignmentEntry,
	Health,
	type NamedObservation,
} from "@hobo/fleet";
import { eligibleForActive, failingLongerThan } from "@hobo/fleet/observation";
import { BackendFleetError } from "./errors.js";
import {
	type FleetFinancialModel,
	healthReason,
	memberName,
} from "./policy.js";
import type {
	BillingPeriod,
	FleetUsageMeasurement,
	FleetUsageUnit,
} from "./usage.js";

/** Cheapest first. Prepaid is money already spent; pay-as-you-go is money to come. */
export const FLEET_OFFER_TIERS = ["free", "prepaid", "payg"] as const;
export type FleetOfferTier = (typeof FLEET_OFFER_TIERS)[number];

// domain-view: the parsed offer, constructible only through parseFleetOffer; the generated FleetOffer in backend_fleet_pb.ts is its wire form.
export type FleetOffer = {
	readonly model: FleetFinancialModel;
	readonly tier: FleetOfferTier;
	/** Most this member may cost in a period, in micro-dollars. Absent: zero. */
	readonly capMicros: number | undefined;
};

export function parseFleetOffer(input: FleetOffer): FleetOffer {
	if (!FLEET_OFFER_TIERS.includes(input.tier))
		throw new BackendFleetError(
			"FLEET_CONFIGURATION_INVALID",
			"offer tier is not a known tier",
			{ detail: { field: "tier" } },
		);
	if (
		input.capMicros !== undefined &&
		(!Number.isSafeInteger(input.capMicros) || input.capMicros < 0)
	)
		throw new BackendFleetError(
			"FLEET_CONFIGURATION_INVALID",
			"capMicros must be a non-negative integer",
			{ detail: { field: "capMicros" } },
		);
	return Object.freeze({
		model: input.model,
		tier: input.tier,
		capMicros: input.capMicros,
	});
}

// domain-view: the parsed marks, constructible only through parseFleetRoutingMarks; the generated FleetRoutingMarks in backend_fleet_pb.ts is its wire form.
export type FleetRoutingMarks = {
	/** Leave the active member when it is projected to reach this fraction. */
	readonly switchAt: number;
	/** Take a member only while it is projected below this fraction. */
	readonly switchBackBelow: number;
	/** No move for preference sooner than this after the previous decision. */
	readonly minDwellMs: number;
	/** How long the active member must have failed before it is left. */
	readonly failoverAfterMs: number;
};

export const DEFAULT_FLEET_ROUTING_MARKS: FleetRoutingMarks = Object.freeze({
	switchAt: 0.9,
	switchBackBelow: 0.8,
	minDwellMs: 3_600_000,
	failoverAfterMs: 60_000,
});

export function parseFleetRoutingMarks(
	input: FleetRoutingMarks,
): FleetRoutingMarks {
	const fraction = (value: number) =>
		Number.isFinite(value) && value > 0 && value <= 1;
	if (!fraction(input.switchAt) || !fraction(input.switchBackBelow))
		throw new BackendFleetError(
			"FLEET_CONFIGURATION_INVALID",
			"switchAt and switchBackBelow must be fractions in (0, 1]",
			{ detail: { field: "switchAt" } },
		);
	if (input.switchBackBelow >= input.switchAt)
		throw new BackendFleetError(
			"FLEET_CONFIGURATION_INVALID",
			"switchBackBelow must be lower than switchAt, or the fleet flaps",
			{ detail: { field: "switchBackBelow" } },
		);
	for (const [field, value] of [
		["minDwellMs", input.minDwellMs],
		["failoverAfterMs", input.failoverAfterMs],
	] as const)
		if (!Number.isSafeInteger(value) || value < 0)
			throw new BackendFleetError(
				"FLEET_CONFIGURATION_INVALID",
				`${field} must be a non-negative integer`,
				{ detail: { field } },
			);
	return Object.freeze({ ...input });
}

export type FleetRoutingInput = {
	readonly assignment: AssignmentEntry;
	/** Every member, in configured order (the last tie-break). */
	readonly members: readonly string[];
	/** What one tick saw of each member; `usage` is what it has spent this period. */
	readonly observations: readonly NamedObservation[];
	/** The fleet's whole workload this period, in every unit any offer bills. */
	readonly workload: readonly FleetUsageMeasurement[];
	readonly offers: readonly FleetOffer[];
	readonly marks: FleetRoutingMarks;
	readonly period: BillingPeriod;
	readonly nowMs: number;
};

// domain-view: one ranked member as routeFleetByBudget returns it; the generated FleetRouteCandidate in backend_fleet_pb.ts is its wire form.
export type FleetRouteCandidate = {
	readonly backend: string;
	readonly tier: FleetOfferTier | undefined;
	/** Could be moved to (or, for the active member, stayed on). */
	readonly eligible: boolean;
	/** Highest projected fraction of an allowance it would stop at. */
	readonly projectedFraction: number | undefined;
	/** Projected cost of the period, micro-dollars. */
	readonly projectedCostMicros: number | undefined;
	readonly reasons: readonly string[];
};

export const FLEET_ROUTE_ACTIONS = [
	"keep",
	"hold",
	"switch",
	"failover",
] as const;
export type FleetRouteAction = (typeof FLEET_ROUTE_ACTIONS)[number];

// domain-view: routeFleetByBudget's answer; the generated FleetRoute in backend_fleet_pb.ts is its wire form.
export type FleetRoute = {
	readonly action: FleetRouteAction;
	readonly epoch: number;
	readonly active: string | undefined;
	readonly target: string | undefined;
	readonly reasons: readonly string[];
	/** The active member first, then every other member, best first. */
	readonly candidates: readonly FleetRouteCandidate[];
	readonly decidedAtMs: number;
};

type Projection = {
	readonly tier: FleetOfferTier | undefined;
	readonly fraction: number | undefined;
	readonly fractionUnit: FleetUsageUnit | undefined;
	readonly costMicros: number | undefined;
	readonly capMicros: number;
	readonly unknowns: readonly string[];
};

const TIER_RANK = {
	free: 0,
	prepaid: 1,
	payg: 2,
} as const satisfies Record<FleetOfferTier, number>;

function amount(
	measurements: readonly Readonly<{ unit: string; used: number }>[] | undefined,
	unit: FleetUsageUnit,
): number | undefined {
	return measurements?.find((entry) => entry.unit === unit)?.used;
}

function project(input: FleetRoutingInput, backend: string): Projection {
	const offer = input.offers.find((entry) => entry.model.backend === backend);
	const own = input.observations.find((entry) => entry.name === backend);
	const elapsed = Math.max(1, input.nowMs - input.period.startsAtMs);
	const remaining = Math.max(0, input.period.endsAtMs - input.nowMs);
	const unknowns: string[] = [];
	if (offer === undefined)
		return {
			tier: undefined,
			fraction: undefined,
			fractionUnit: undefined,
			costMicros: undefined,
			capMicros: 0,
			unknowns: ["no-financial-model"],
		};
	let fraction = 0;
	let fractionUnit: FleetUsageUnit | undefined;
	let overage = 0;
	for (const allowance of offer.model.allowances) {
		const workload = amount(input.workload, allowance.unit);
		if (workload === undefined) {
			unknowns.push(`${allowance.unit}:workload-not-measured`);
			continue;
		}
		const spent = amount(own?.observation.usage, allowance.unit) ?? 0;
		const projected = spent + (workload / elapsed) * remaining;
		if (allowance.included === undefined) {
			unknowns.push(`${allowance.unit}:allowance-unknown`);
			continue;
		}
		if (allowance.beyond === "metered") {
			overage +=
				Math.max(0, projected - allowance.included) *
				(allowance.meteredMicrosPerUnit ?? 0);
			continue;
		}
		const share =
			allowance.included === 0
				? projected > 0
					? Number.POSITIVE_INFINITY
					: 0
				: projected / allowance.included;
		if (share >= fraction) {
			fraction = share;
			fractionUnit = allowance.unit;
		}
	}
	const fee = offer.model.fixedMonthlyFeeMicros;
	if (fee === undefined) unknowns.push("fee-unknown");
	return {
		tier: offer.tier,
		fraction: unknowns.length > 0 ? undefined : fraction,
		fractionUnit,
		costMicros:
			fee === undefined || unknowns.length > 0
				? undefined
				: Math.ceil(fee + overage),
		capMicros: offer.capMicros ?? 0,
		unknowns,
	};
}

function percent(fraction: number): string {
	return Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : "inf";
}

/** Decide which member should be active now. Pure: same input, same route. */
export function routeFleetByBudget(input: FleetRoutingInput): FleetRoute {
	const { assignment, marks, nowMs } = input;
	const members = input.members.map((member) => memberName(member));
	const base = {
		epoch: assignment.epoch,
		active: assignment.active,
		decidedAtMs: nowMs,
	};
	const hold = (reasons: string[]): FleetRoute => ({
		...base,
		action: "hold",
		target: undefined,
		reasons,
		candidates: [],
	});
	if (assignment.sealed) return hold(["switch-in-flight"]);
	if (assignment.active === undefined) return hold(["no-writer"]);
	const activeSeen = input.observations.find(
		(entry) => entry.name === assignment.active,
	);
	if (activeSeen === undefined) return hold(["writer-not-observed"]);

	const order = (backend: string) => {
		const index = members.indexOf(backend);
		return index < 0 ? Number.MAX_SAFE_INTEGER : index;
	};
	const failing = activeSeen.observation.health !== Health.REACHABLE;
	// Health is decided in one place (`eligibleForActive`); a cache member holds
	// no replicated state, so lag is never considered.
	const health = eligibleForActive(input.observations, {
		mode: failing ? "failover" : "switch",
		recoveryPointMs: undefined,
	});
	const evaluate = (backend: string, active: boolean) => {
		const index = input.observations.findIndex(
			(entry) => entry.name === backend,
		);
		const verdict = index < 0 ? undefined : health[index];
		const projection = project(input, backend);
		const reasons: string[] = [];
		if (verdict === undefined) reasons.push("not-observed");
		else reasons.push(...verdict.reasons);
		reasons.push(...projection.unknowns);
		const known = projection.unknowns.length === 0;
		const mark = active ? marks.switchAt : marks.switchBackBelow;
		const fraction = projection.fraction ?? 0;
		const hardStop = known && fraction >= 1;
		const nearStop = known && fraction >= mark;
		const tooDear =
			known && (projection.costMicros ?? 0) > projection.capMicros;
		if (nearStop)
			reasons.push(
				`${projection.fractionUnit ?? "allowance"} projected ${percent(fraction)}`,
			);
		if (tooDear) reasons.push("over-budget-cap");
		const reachable = verdict?.eligible === true;
		return {
			candidate: {
				backend,
				tier: projection.tier,
				eligible: reachable && known && !nearStop && !tooDear,
				projectedFraction: projection.fraction,
				projectedCostMicros: projection.costMicros,
				reasons,
			} satisfies FleetRouteCandidate,
			// A failover takes an unknown member, never one past a stop or a cap.
			failoverTarget: reachable && !hardStop && !tooDear,
			rank: [
				projection.tier === undefined ? 3 : TIER_RANK[projection.tier],
				projection.costMicros ?? Number.MAX_SAFE_INTEGER,
				order(backend),
			] as const,
		};
	};
	const better = (
		left: readonly [number, number, number],
		right: readonly [number, number, number],
	) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || 0;
	const current = evaluate(assignment.active, true);
	const others = members
		.filter((backend) => backend !== assignment.active)
		.map((backend) => evaluate(backend, false))
		.sort(
			(left, right) =>
				Number(right.candidate.eligible) - Number(left.candidate.eligible) ||
				better(left.rank, right.rank) ||
				(left.candidate.backend < right.candidate.backend ? -1 : 1),
		);
	const candidates = [
		current.candidate,
		...others.map((entry) => entry.candidate),
	];
	const route = (
		action: FleetRouteAction,
		target: string | undefined,
		reasons: string[],
	): FleetRoute => ({ ...base, action, target, reasons, candidates });

	if (failing) {
		const cause = `writer-${healthReason(activeSeen)}`;
		if (!failingLongerThan(activeSeen.observation, marks.failoverAfterMs))
			return route("hold", undefined, [cause, "awaiting-failover-threshold"]);
		const target =
			others.find((entry) => entry.candidate.eligible) ??
			others.find((entry) => entry.failoverTarget);
		return target === undefined
			? route("hold", undefined, [cause, "no-reachable-standby"])
			: route("failover", target.candidate.backend, [cause]);
	}

	const best = others.find((entry) => entry.candidate.eligible);
	const knownActive = current.candidate.projectedFraction !== undefined;
	if (knownActive && !current.candidate.eligible) {
		const signals = current.candidate.reasons.filter(
			(reason) => reason.includes("projected") || reason === "over-budget-cap",
		);
		return best === undefined
			? route("keep", undefined, [...signals, "no-feasible-standby"])
			: route("switch", best.candidate.backend, signals);
	}
	// A move costs a cold start, so the configured order alone is no reason:
	// only a cheaper tier, or a cheaper month within one, is.
	if (
		best !== undefined &&
		knownActive &&
		(best.rank[0] < current.rank[0] ||
			(best.rank[0] === current.rank[0] && best.rank[1] < current.rank[1]))
	) {
		const reason = `preferred-${best.candidate.tier ?? "unknown"}`;
		if (nowMs - assignment.decidedAtMs < marks.minDwellMs)
			return route("keep", undefined, [reason, "minimum-dwell-not-reached"]);
		return route("switch", best.candidate.backend, [reason]);
	}
	return route("keep", undefined, ["writer-healthy"]);
}
