/**
 * The fleet policy: keep the writer, switch to a standby, or fail over.
 *
 * `decideFleet` is a pure function. It reads no clock and no database; a host
 * hands it the current assignment, what it observed of every backend, what
 * every backend costs, and the instant. It answers with one action, the
 * reasons, and every standby ranked, so a log line of its result explains the
 * decision without anything else.
 *
 * Two moves exist and they are different in kind:
 *
 * - **Switch** is planned. The writer is healthy but is projected to run out
 *   of a hard allowance, or is not affordable under the budget. Nothing is
 *   lost: the host seals the fleet, copies once more, and moves.
 * - **Failover** is unplanned. The writer has been failing for longer than a
 *   threshold. The freshest standby is promoted and whatever was written after
 *   its last copy is lost, so a standby older than the recovery point
 *   objective is never promoted here. That takes a person and an override.
 *
 * The budget itself is not decided here. Whether running a period on a backend
 * is affordable is asked of an injected check, so there is one budget engine
 * and it is the host's.
 */
import {
	type AssignmentEntry,
	Health,
	type NamedObservation,
	parseMemberName,
} from "@hobo/fleet";
import { eligibleForActive, failingLongerThan } from "@hobo/fleet/observation";
import { BackendFleetError } from "./errors.js";
import {
	type BillingPeriod,
	FLEET_LEVEL_UNITS,
	FLEET_USAGE_UNITS,
	type FleetUsageMeasurement,
	type FleetUsageUnit,
} from "./usage.js";

export const FLEET_OVERAGE_KINDS = ["hard-stop", "metered", "unknown"] as const;

/**
 * What happens beyond an allowance: the service stops, bills, or nobody knows.
 * A known allowance with an unknown overage is treated as a hard stop: either
 * the service stops or it bills, and neither is something to walk into.
 */
export type FleetOverageKind = (typeof FLEET_OVERAGE_KINDS)[number];

// domain-view: the parsed in-process allowance, constructible only through parseFleetFinancialModel; the generated FleetAllowance in backend_fleet_pb.ts is its wire form.
export type FleetAllowance = {
	readonly unit: FleetUsageUnit;
	/** Included per period (or in total for storage). Absent means unknown. */
	readonly included: number | undefined;
	readonly beyond: FleetOverageKind;
	/**
	 * Price per unit beyond the allowance, in millionths of a US dollar. May
	 * be fractional: $0.40 per million units is 0.4.
	 */
	readonly meteredMicrosPerUnit: number | undefined;
};

// domain-view: the parsed in-process model, constructible only through parseFleetFinancialModel; the generated FleetFinancialModel in backend_fleet_pb.ts is its wire form.
export type FleetFinancialModel = {
	readonly backend: string;
	readonly plan: string;
	/** Fixed fee per month in millionths of a US dollar. Absent means unknown. */
	readonly fixedMonthlyFeeMicros: number | undefined;
	readonly allowances: readonly FleetAllowance[];
	/** Where the numbers came from, and the day somebody looked. */
	readonly evidence: {
		readonly source: string;
		readonly observedAt: string;
	};
};

function refuse(message: string, field: string): never {
	throw new BackendFleetError("FLEET_CONFIGURATION_INVALID", message, {
		detail: { field },
	});
}

/**
 * A member's name in its fleet (`parseMemberName`, which replaced
 * `parseFleetBackendId`), refused with this package's configuration error so
 * a caller that matches on `code` keeps working.
 */
export function memberName(value: string, field = "backend"): string {
	try {
		return parseMemberName(value, field);
	} catch {
		return refuse(`${field} must be a short lower-case token`, field);
	}
}

function quantity(value: number | undefined, field: string): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
		refuse(`${field} must be a non-negative integer`, field);
}

/** A price per unit may be a fraction of a micro-dollar ($0.40 a million is 0.4). */
function price(value: number | undefined, field: string): void {
	if (value !== undefined && (!Number.isFinite(value) || value < 0))
		refuse(`${field} must be a non-negative number`, field);
}

/**
 * Parse a financial model. Afterwards a metered allowance always has a price,
 * no other allowance has one, each unit appears once, and the evidence names a
 * source and a calendar day. "Unknown" stays representable on purpose: a
 * number nobody has verified must not be invented to fill a field.
 */
export function parseFleetFinancialModel(
	input: FleetFinancialModel,
): FleetFinancialModel {
	const backend = memberName(input.backend);
	if (!/^[a-z0-9][a-z0-9 ._-]{0,63}$/u.test(input.plan))
		refuse("plan must be a short lower-case name", "plan");
	quantity(input.fixedMonthlyFeeMicros, "fixedMonthlyFeeMicros");
	const units = new Set<string>();
	for (const allowance of input.allowances) {
		if (!FLEET_USAGE_UNITS.includes(allowance.unit))
			refuse("allowance unit is not a known unit", "unit");
		if (units.has(allowance.unit))
			refuse("each unit has at most one allowance", "unit");
		units.add(allowance.unit);
		quantity(allowance.included, "included");
		price(allowance.meteredMicrosPerUnit, "meteredMicrosPerUnit");
		if (!FLEET_OVERAGE_KINDS.includes(allowance.beyond))
			refuse("overage kind is not a known kind", "beyond");
		if (
			(allowance.beyond === "metered") !==
			(allowance.meteredMicrosPerUnit !== undefined)
		)
			refuse("exactly a metered allowance carries a price", "beyond");
	}
	if (
		input.evidence.source.length === 0 ||
		input.evidence.source.length > 300 ||
		!/^\d{4}-\d{2}-\d{2}$/u.test(input.evidence.observedAt)
	)
		refuse("evidence needs a source and a YYYY-MM-DD date", "evidence");
	return Object.freeze({
		backend,
		plan: input.plan,
		fixedMonthlyFeeMicros: input.fixedMonthlyFeeMicros,
		allowances: Object.freeze(
			input.allowances.map((allowance) => Object.freeze({ ...allowance })),
		),
		evidence: Object.freeze({ ...input.evidence }),
	});
}

export type FleetPolicy = {
	/** Recovery point objective: the oldest standby an unplanned move may promote. */
	readonly rpoMs: number;
	/** How long the writer must have been failing before a failover. */
	readonly failoverAfterMs: number;
	/** Switch when a hard allowance is projected to run out within this. */
	readonly exhaustionHorizonMs: number;
	/** A standby must have this many horizons of headroom to be switched to. */
	readonly hysteresisFactor: number;
	/** No planned switch sooner than this after the previous decision. */
	readonly minDwellMs: number;
};

export const DEFAULT_FLEET_POLICY: FleetPolicy = Object.freeze({
	rpoMs: 20 * 60_000,
	failoverAfterMs: 60_000,
	exhaustionHorizonMs: 3 * 24 * 3_600_000,
	hysteresisFactor: 2,
	minDwellMs: 3_600_000,
});

export function parseFleetPolicy(input: FleetPolicy): FleetPolicy {
	for (const [field, value] of [
		["rpoMs", input.rpoMs],
		["failoverAfterMs", input.failoverAfterMs],
		["exhaustionHorizonMs", input.exhaustionHorizonMs],
		["minDwellMs", input.minDwellMs],
	] as const)
		if (!Number.isSafeInteger(value) || value < 0)
			refuse(`${field} must be a non-negative integer`, field);
	if (!Number.isFinite(input.hysteresisFactor) || input.hysteresisFactor < 1)
		refuse("hysteresisFactor must be at least 1", "hysteresisFactor");
	return Object.freeze({ ...input });
}

export type FleetBudgetRequest = {
	readonly backend: string;
	/** Projected cost of the period: the fixed fee plus metered use beyond it. */
	readonly costBoundMicros: number;
	/** Projected use of each allowance unit over the period. */
	readonly measurements: readonly FleetUsageMeasurement[];
	readonly nowMs: number;
};

export type FleetBudgetVerdict = {
	readonly ok: boolean;
	readonly code: string;
	readonly reason: string;
};

/** The host's budget engine, asked whether a period on a backend is affordable. */
export type FleetBudgetCheck = (
	request: FleetBudgetRequest,
) => FleetBudgetVerdict;

export const FLEET_FEASIBILITIES = [
	"feasible",
	"unknown",
	"infeasible",
] as const;

export type FleetFeasibility = (typeof FLEET_FEASIBILITIES)[number];

// domain-view: the in-process ranking entry decideFleet returns; the generated FleetCandidate in backend_fleet_pb.ts is its wire form.
export type FleetCandidate = {
	readonly backend: string;
	/** Could be moved to by the action the decision considered. */
	readonly eligible: boolean;
	readonly feasibility: FleetFeasibility;
	readonly lagMs: number | undefined;
	/**
	 * Time until the first hard allowance runs out with the fleet's workload on
	 * this backend. Absent when no hard allowance is projected to run out.
	 */
	readonly exhaustsInMs: number | undefined;
	readonly reasons: readonly string[];
};

export const FLEET_ACTIONS = ["keep", "hold", "switch", "failover"] as const;

/**
 * `keep`: the writer stays. `hold`: something is wrong and no move is allowed.
 * `switch`: planned move, nothing lost. `failover`: unplanned promotion.
 */
export type FleetAction = (typeof FLEET_ACTIONS)[number];

// domain-view: the in-process decision decideFleet returns; the generated FleetDecision in backend_fleet_pb.ts is its wire form.
export type FleetDecision = {
	readonly action: FleetAction;
	/** The epoch of the assignment the decision was made about. */
	readonly epoch: number;
	readonly writer: string | undefined;
	readonly target: string | undefined;
	/** For a failover: the promoted standby's lag, the bound on what is lost. */
	readonly lossWindowMs: number | undefined;
	readonly reasons: readonly string[];
	/** Every standby, best first. */
	readonly candidates: readonly FleetCandidate[];
	readonly decidedAtMs: number;
};

export type FleetDecisionInput = {
	readonly assignment: AssignmentEntry;
	/** Every backend as this tick saw it, by its name in the fleet. */
	readonly observations: readonly NamedObservation[];
	readonly models: readonly FleetFinancialModel[];
	readonly policy: FleetPolicy;
	readonly period: BillingPeriod;
	readonly checkBudget: FleetBudgetCheck;
	readonly nowMs: number;
};

type Projection = {
	/** A number, or "never", or "unknown" when a needed fact is missing. */
	readonly exhaustsInMs: number | "never" | "unknown";
	readonly exhaustedUnit: FleetUsageUnit | undefined;
	readonly unknowns: readonly string[];
	readonly verdict: FleetBudgetVerdict;
};

function measured(
	seen: NamedObservation | undefined,
	unit: FleetUsageUnit,
): number | undefined {
	return seen?.observation.usage.find((entry) => entry.unit === unit)?.used;
}

/**
 * `eligibleForActive` reports a member that is not prepared to become active
 * as `not-ready`; for a database standby that is its schema, so the reason
 * keeps the name this policy always gave it.
 */
function standbyReason(reason: string): string {
	return reason === "not-ready" ? "schema-not-current" : reason;
}

/**
 * What would happen with the fleet's workload on `backend`.
 *
 * The workload is what the writer is measured to do: its use this period
 * divided by the time elapsed gives a rate, and its size gives a level. A
 * standby's own use so far (copies, lease reads) is already spent from its
 * allowance. Anything not measured or not known makes the answer `unknown`
 * rather than optimistic, and `unknown` neither causes a move nor is moved to.
 */
function project(
	input: FleetDecisionInput,
	backend: string,
	writer: NamedObservation | undefined,
): Projection {
	const model = input.models.find((entry) => entry.backend === backend);
	const own = input.observations.find((entry) => entry.name === backend);
	const elapsed = Math.max(1, input.nowMs - input.period.startsAtMs);
	const remaining = Math.max(0, input.period.endsAtMs - input.nowMs);
	const unknowns: string[] = [];
	let exhaustsInMs: number | "never" = "never";
	let exhaustedUnit: FleetUsageUnit | undefined;
	let overageMicros = 0;
	const measurements: FleetUsageMeasurement[] = [];
	if (model === undefined) unknowns.push("no-financial-model");
	for (const allowance of model?.allowances ?? []) {
		const level = FLEET_LEVEL_UNITS.includes(allowance.unit);
		const workload = measured(writer, allowance.unit);
		if (workload === undefined) {
			unknowns.push(`${allowance.unit}:workload-not-measured`);
			continue;
		}
		const spent = level ? 0 : (measured(own, allowance.unit) ?? 0);
		const rate = level ? 0 : workload / elapsed;
		const projected = level ? workload : Math.ceil(spent + rate * remaining);
		measurements.push({ unit: allowance.unit, used: projected });
		if (allowance.included === undefined) {
			unknowns.push(`${allowance.unit}:allowance-unknown`);
			continue;
		}
		if (allowance.beyond === "metered") {
			overageMicros +=
				Math.max(0, projected - allowance.included) *
				(allowance.meteredMicrosPerUnit ?? 0);
			continue;
		}
		const left = allowance.included - (level ? workload : spent);
		const runsOutIn =
			left <= 0 ? 0 : rate <= 0 ? undefined : Math.floor(left / rate);
		if (
			runsOutIn !== undefined &&
			(exhaustsInMs === "never" || runsOutIn < exhaustsInMs)
		) {
			exhaustsInMs = runsOutIn;
			exhaustedUnit = allowance.unit;
		}
	}
	const fee = model?.fixedMonthlyFeeMicros;
	if (model !== undefined && fee === undefined) unknowns.push("fee-unknown");
	// The budget is asked only about a complete picture. With a fact missing
	// the answer is "unknown", which never causes a move and is never moved to.
	const verdict =
		fee === undefined || unknowns.length > 0
			? { ok: true, code: "budget-not-evaluated", reason: "a fact is missing" }
			: input.checkBudget({
					backend,
					costBoundMicros: Math.ceil(fee + overageMicros),
					measurements,
					nowMs: input.nowMs,
				});
	return {
		exhaustsInMs:
			exhaustsInMs === "never" && unknowns.length > 0
				? "unknown"
				: exhaustsInMs,
		exhaustedUnit,
		unknowns,
		verdict,
	};
}

const FEASIBILITY_RANK = { feasible: 0, unknown: 1, infeasible: 2 } as const;

/** A duration for a reason string: seconds when short, minutes otherwise. */
function span(ms: number): string {
	return ms < 120_000
		? `${Math.round(ms / 1000)}s`
		: `${Math.round(ms / 60_000)}m`;
}

/** The health token `eligibleForActive` gives a failing member (`unreachable`, `quota-exhausted`, …). */
export function healthReason(seen: NamedObservation): string {
	const [verdict] = eligibleForActive([seen], {
		mode: "switch",
		recoveryPointMs: undefined,
	});
	return verdict?.reasons[0] ?? "unknown";
}

/** Decide what the fleet should do now. Pure: same input, same decision. */
export function decideFleet(input: FleetDecisionInput): FleetDecision {
	const { assignment, policy, nowMs } = input;
	const base = {
		epoch: assignment.epoch,
		writer: assignment.active,
		decidedAtMs: nowMs,
	};
	const writer = input.observations.find(
		(entry) => entry.name === assignment.active,
	);
	if (assignment.sealed || assignment.active === undefined || !writer)
		return {
			...base,
			action: "hold",
			target: undefined,
			lossWindowMs: undefined,
			reasons: [
				assignment.sealed
					? "switch-in-flight"
					: assignment.active === undefined
						? "no-writer"
						: "writer-not-observed",
			],
			candidates: [],
		};
	const failing = writer.observation.health !== Health.REACHABLE;
	const required = policy.exhaustionHorizonMs * policy.hysteresisFactor;
	const standbys = input.observations.filter(
		(entry) => entry.name !== assignment.active,
	);
	// Health is decided in one place (`eligibleForActive`); lag is judged
	// against the recovery point only for a failover, as it always was.
	const health = eligibleForActive(standbys, {
		mode: failing ? "failover" : "switch",
		recoveryPointMs: policy.rpoMs,
	});
	const candidates = standbys
		.map((entry, index) => {
			const projection = project(input, entry.name, writer);
			const reasons: string[] = (health[index]?.reasons ?? []).map(
				standbyReason,
			);
			const eligibleSoFar = health[index]?.eligible === true;
			const short =
				projection.exhaustsInMs !== "never" &&
				projection.exhaustsInMs !== "unknown" &&
				projection.exhaustsInMs < required;
			const feasibility: FleetFeasibility =
				short || !projection.verdict.ok
					? "infeasible"
					: projection.unknowns.length > 0
						? "unknown"
						: "feasible";
			if (short)
				reasons.push(
					`${projection.exhaustedUnit ?? "allowance"} runs out in ${span(Number(projection.exhaustsInMs))}`,
				);
			if (!projection.verdict.ok) reasons.push(projection.verdict.code);
			reasons.push(...projection.unknowns);
			return {
				backend: entry.name,
				// A failover takes any standby within the objective, affordable or
				// not: a relay that is down costs more than a plan. A planned
				// switch moves only to a standby that is provably better.
				eligible: eligibleSoFar && (failing || feasibility === "feasible"),
				feasibility,
				lagMs: entry.observation.lagMs,
				exhaustsInMs:
					projection.exhaustsInMs === "never" ||
					projection.exhaustsInMs === "unknown"
						? undefined
						: projection.exhaustsInMs,
				reasons,
				latency: entry.observation.probeLatencyMs ?? Number.MAX_SAFE_INTEGER,
			};
		})
		.sort(
			(left, right) =>
				Number(right.eligible) - Number(left.eligible) ||
				FEASIBILITY_RANK[left.feasibility] -
					FEASIBILITY_RANK[right.feasibility] ||
				(failing
					? (left.lagMs ?? Number.MAX_SAFE_INTEGER) -
						(right.lagMs ?? Number.MAX_SAFE_INTEGER)
					: (right.exhaustsInMs ?? Number.MAX_SAFE_INTEGER) -
						(left.exhaustsInMs ?? Number.MAX_SAFE_INTEGER)) ||
				left.latency - right.latency ||
				(left.backend < right.backend ? -1 : 1),
		)
		.map(({ latency: _latency, ...candidate }) => candidate);
	const best = candidates.find((candidate) => candidate.eligible);

	if (failing) {
		const cause = `writer-${healthReason(writer)}`;
		if (!failingLongerThan(writer.observation, policy.failoverAfterMs))
			return {
				...base,
				action: "hold",
				target: undefined,
				lossWindowMs: undefined,
				reasons: [cause, "awaiting-failover-threshold"],
				candidates,
			};
		if (best === undefined)
			return {
				...base,
				action: "hold",
				target: undefined,
				lossWindowMs: undefined,
				reasons: [cause, "no-standby-within-rpo"],
				candidates,
			};
		return {
			...base,
			action: "failover",
			target: best.backend,
			lossWindowMs: best.lagMs,
			reasons: [cause],
			candidates,
		};
	}

	const projection = project(input, writer.name, writer);
	const signals: string[] = [];
	if (
		projection.exhaustsInMs !== "never" &&
		projection.exhaustsInMs !== "unknown" &&
		projection.exhaustsInMs <= policy.exhaustionHorizonMs
	)
		signals.push(
			`${projection.exhaustedUnit ?? "allowance"}-exhaustion-projected`,
		);
	if (!projection.verdict.ok)
		signals.push(`budget-infeasible:${projection.verdict.code}`);
	if (signals.length === 0)
		return {
			...base,
			action: "keep",
			target: undefined,
			lossWindowMs: undefined,
			reasons: ["writer-healthy"],
			candidates,
		};
	if (nowMs - assignment.decidedAtMs < policy.minDwellMs)
		return {
			...base,
			action: "keep",
			target: undefined,
			lossWindowMs: undefined,
			reasons: [...signals, "minimum-dwell-not-reached"],
			candidates,
		};
	if (best === undefined)
		return {
			...base,
			action: "keep",
			target: undefined,
			lossWindowMs: undefined,
			reasons: [...signals, "no-feasible-standby"],
			candidates,
		};
	return {
		...base,
		action: "switch",
		target: best.backend,
		lossWindowMs: undefined,
		reasons: signals,
		candidates,
	};
}
