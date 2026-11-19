import type { FleetAssignment } from "./assignment.js";
import { type FleetFailureClass, parseFleetBackendId } from "./backend.js";
import { BackendFleetError } from "./errors.js";
import {
	type BillingPeriod,
	FLEET_LEVEL_UNITS,
	FLEET_USAGE_UNITS,
	type FleetUsageMeasurement,
	type FleetUsageUnit,
} from "./usage.js";

export type FleetBackendHealth = "reachable" | FleetFailureClass;

export type FleetObservation = {
	readonly backend: string;
	readonly health: FleetBackendHealth;
	readonly probeLatencyMs: number | undefined;
	readonly failingForMs: number;
	readonly schemaCurrent: boolean;
	readonly standbyLagMs: number | undefined;
	readonly usage: readonly FleetUsageMeasurement[];
};

export const FLEET_OVERAGE_KINDS = ["hard-stop", "metered", "unknown"] as const;

export type FleetOverageKind = (typeof FLEET_OVERAGE_KINDS)[number];

export type FleetAllowance = {
	readonly unit: FleetUsageUnit;
	readonly included: number | undefined;
	readonly beyond: FleetOverageKind;
	readonly meteredMicrosPerUnit: number | undefined;
};

export type FleetFinancialModel = {
	readonly backend: string;
	readonly plan: string;
	readonly fixedMonthlyFeeMicros: number | undefined;
	readonly allowances: readonly FleetAllowance[];
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

function quantity(value: number | undefined, field: string): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
		refuse(`${field} must be a non-negative integer`, field);
}

function price(value: number | undefined, field: string): void {
	if (value !== undefined && (!Number.isFinite(value) || value < 0))
		refuse(`${field} must be a non-negative number`, field);
}

export function parseFleetFinancialModel(
	input: FleetFinancialModel,
): FleetFinancialModel {
	const backend = parseFleetBackendId(input.backend);
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
	readonly rpoMs: number;
	readonly failoverAfterMs: number;
	readonly exhaustionHorizonMs: number;
	readonly hysteresisFactor: number;
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
	readonly costBoundMicros: number;
	readonly measurements: readonly FleetUsageMeasurement[];
	readonly nowMs: number;
};

export type FleetBudgetVerdict = {
	readonly ok: boolean;
	readonly code: string;
	readonly reason: string;
};

export type FleetBudgetCheck = (
	request: FleetBudgetRequest,
) => FleetBudgetVerdict;

export const FLEET_FEASIBILITIES = [
	"feasible",
	"unknown",
	"infeasible",
] as const;

export type FleetFeasibility = (typeof FLEET_FEASIBILITIES)[number];

export type FleetCandidate = {
	readonly backend: string;
	readonly eligible: boolean;
	readonly feasibility: FleetFeasibility;
	readonly lagMs: number | undefined;
	readonly exhaustsInMs: number | undefined;
	readonly reasons: readonly string[];
};

export const FLEET_ACTIONS = ["keep", "hold", "switch", "failover"] as const;

export type FleetAction = (typeof FLEET_ACTIONS)[number];

export type FleetDecision = {
	readonly action: FleetAction;
	readonly epoch: number;
	readonly writer: string | undefined;
	readonly target: string | undefined;
	readonly lossWindowMs: number | undefined;
	readonly reasons: readonly string[];
	readonly candidates: readonly FleetCandidate[];
	readonly decidedAtMs: number;
};

export type FleetDecisionInput = {
	readonly assignment: FleetAssignment;
	readonly observations: readonly FleetObservation[];
	readonly models: readonly FleetFinancialModel[];
	readonly policy: FleetPolicy;
	readonly period: BillingPeriod;
	readonly checkBudget: FleetBudgetCheck;
	readonly nowMs: number;
};

type Projection = {
	readonly exhaustsInMs: number | "never" | "unknown";
	readonly exhaustedUnit: FleetUsageUnit | undefined;
	readonly unknowns: readonly string[];
	readonly verdict: FleetBudgetVerdict;
};

function measured(
	observation: FleetObservation | undefined,
	unit: FleetUsageUnit,
): number | undefined {
	return observation?.usage.find((entry) => entry.unit === unit)?.used;
}

function project(
	input: FleetDecisionInput,
	backend: string,
	writer: FleetObservation | undefined,
): Projection {
	const model = input.models.find((entry) => entry.backend === backend);
	const own = input.observations.find((entry) => entry.backend === backend);
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

function span(ms: number): string {
	return ms < 120_000
		? `${Math.round(ms / 1000)}s`
		: `${Math.round(ms / 60_000)}m`;
}

export function decideFleet(input: FleetDecisionInput): FleetDecision {
	const { assignment, policy, nowMs } = input;
	const base = {
		epoch: assignment.epoch,
		writer: assignment.active,
		decidedAtMs: nowMs,
	};
	const writer = input.observations.find(
		(entry) => entry.backend === assignment.active,
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
	const failing = writer.health !== "reachable";
	const required = policy.exhaustionHorizonMs * policy.hysteresisFactor;
	const candidates = input.observations
		.filter((entry) => entry.backend !== assignment.active)
		.map((entry) => {
			const projection = project(input, entry.backend, writer);
			const reasons: string[] = [];
			if (entry.health !== "reachable") reasons.push(entry.health);
			if (!entry.schemaCurrent) reasons.push("schema-not-current");
			if (failing) {
				if (entry.standbyLagMs === undefined) reasons.push("never-copied");
				else if (entry.standbyLagMs > policy.rpoMs)
					reasons.push(
						`lag ${span(entry.standbyLagMs)} exceeds rpo ${span(policy.rpoMs)}`,
					);
			}
			const eligibleSoFar = reasons.length === 0;
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
				backend: entry.backend,
				eligible: eligibleSoFar && (failing || feasibility === "feasible"),
				feasibility,
				lagMs: entry.standbyLagMs,
				exhaustsInMs:
					projection.exhaustsInMs === "never" ||
					projection.exhaustsInMs === "unknown"
						? undefined
						: projection.exhaustsInMs,
				reasons,
				latency: entry.probeLatencyMs ?? Number.MAX_SAFE_INTEGER,
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
		const cause = `writer-${writer.health}`;
		if (writer.failingForMs < policy.failoverAfterMs)
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

	const projection = project(input, writer.backend, writer);
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
