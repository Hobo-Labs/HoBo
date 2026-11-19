import type {
	ApplyResult,
	PolicyDecision,
	RoutingPlan,
	RoutingPlanId,
	RoutingStatus,
	TrafficRoutingOfferingId,
	TrafficRoutingPort,
} from "@hobo/core";
import { parseRoutingPlanId } from "@hobo/core";
import type { DispatchFact } from "@hobo/dispatcher";
import {
	type CutoverHealthGate,
	type CutoverPrecondition,
	executeRoutingCutover,
	type RoutingCutoverResult,
	type RoutingTopology,
} from "@hobo/stations";
import type { CampId, CdContext, TrafficShifter } from "../ports.js";
import { stageShare } from "../rollout/routing.js";

export type CampRoutingContext = Readonly<{
	port: TrafficRoutingPort;
	offerings: readonly TrafficRoutingOfferingId[];
	topology: RoutingTopology;
	policyDecision: PolicyDecision;
	stableBackendId: string;
	candidateBackendId: string;
	precondition: Omit<CutoverPrecondition, "incumbentPlan" | "incumbentPlanId">;
	incumbentPlan: RoutingPlan;
	healthGate: CutoverHealthGate;
	restorationHealthGate: CutoverHealthGate;
	beforeApply: (
		plan: RoutingPlan,
		phase: "ramp" | "restore",
		percent: number,
	) => Promise<void>;
	minObservationSeconds?: number;
	maxObservationAgeSeconds?: number;
	consecutiveFailuresToRollback?: number;
}>;

export type CutoverTrafficShifterDeps = Readonly<{
	routing: (campId: CampId) => Promise<CampRoutingContext | undefined>;
	now: () => number;
	onFact?: (campId: CampId, fact: DispatchFact) => void;
}>;

class StageBoundary extends Error {
	constructor(readonly percent: number) {
		super(`stage boundary: the rollout stops this cutover at ${percent}%`);
		this.name = "StageBoundary";
	}
}

function unrealized(
	planId: RoutingPlanId,
	notes: readonly string[],
	realized: "none" | "partial" = "none",
): ApplyResult {
	return {
		planId,
		provider: "other",
		realized,
		notes: [...notes],
		unmet: [...notes],
	};
}

export function cutoverPlanId(stagePlanId: string): RoutingPlanId {
	const match = /:p(\d+)$/.exec(stagePlanId);
	const percent = match ? Number(match[1]) : 100;
	return parseRoutingPlanId(`${stagePlanId}:p${percent === 0 ? 100 : percent}`);
}

function reasonCodes(result: RoutingCutoverResult): readonly string[] {
	return result.reasons.map((r) => `${r.code}: ${r.message}`);
}

export function createCutoverTrafficShifter(
	d: CutoverTrafficShifterDeps,
): TrafficShifter {
	const history = new Map<CampId, RoutingPlan[]>();
	const remember = (campId: CampId, plan: RoutingPlan) => {
		history.set(campId, [...(history.get(campId) ?? []), plan].slice(-8));
	};

	async function incumbentFor(
		campId: CampId,
		context: CampRoutingContext,
	): Promise<RoutingPlan> {
		const candidates = [...(history.get(campId) ?? [])].reverse();
		for (const plan of candidates) {
			const status = await context.port.status(plan.planId);
			if (status?.active === true && status.realized === "full") return plan;
		}
		return context.incumbentPlan;
	}

	async function shift(
		input: Readonly<{ campId: CampId; plan: RoutingPlan; signal: AbortSignal }>,
		_ctx: CdContext,
	): Promise<ApplyResult> {
		const context = await d.routing(input.campId);
		if (!context)
			return unrealized(input.plan.planId, ["traffic-unconfigured"]);
		const percent = stageShare(input.plan);
		if (percent === undefined)
			return unrealized(input.plan.planId, [
				"traffic-plan-invalid: not a stable/candidate stage plan",
			]);
		const incumbent = await incumbentFor(input.campId, context);
		const toStable = percent === 0;
		const rampSteps = toStable || percent === 100 ? [100] : [percent, 100];
		const acknowledged = new Map<string, ApplyResult>();
		let boundaryReached = false;
		const port: TrafficRoutingPort = {
			provider: context.port.provider,
			async apply(plan) {
				const result = await context.port.apply(plan);
				acknowledged.set(plan.planId, result);
				return result;
			},
			status: (planId) => context.port.status(planId),
		};
		const result = await executeRoutingCutover({
			topology: context.topology,
			policyDecision: context.policyDecision,
			port,
			fromBackendId: toStable
				? context.candidateBackendId
				: context.stableBackendId,
			toBackendId: toStable
				? context.stableBackendId
				: context.candidateBackendId,
			rampSteps,
			healthGate: context.healthGate,
			restorationHealthGate: context.restorationHealthGate,
			precondition: {
				...context.precondition,
				incumbentPlan: incumbent,
				incumbentPlanId: incumbent.planId,
			},
			...(context.minObservationSeconds === undefined
				? undefined
				: { minObservationSeconds: context.minObservationSeconds }),
			...(context.maxObservationAgeSeconds === undefined
				? undefined
				: { maxObservationAgeSeconds: context.maxObservationAgeSeconds }),
			...(context.consecutiveFailuresToRollback === undefined
				? undefined
				: {
						consecutiveFailuresToRollback:
							context.consecutiveFailuresToRollback,
					}),
			clock: () => new Date(d.now()).toISOString(),
			planIdPrefix: input.plan.planId,
			onFact: (fact) => d.onFact?.(input.campId, fact),
			async beforeApply(plan, phase, step) {
				if (phase === "ramp" && !toStable && step > percent) {
					boundaryReached = true;
					throw new StageBoundary(percent);
				}
				await context.beforeApply(plan, phase, step);
			},
		});
		const stagePlan = result.plans.find(
			(plan) => plan.planId === cutoverPlanId(input.plan.planId),
		);
		if (result.ok && result.finalApplyResult) {
			if (stagePlan) remember(input.campId, stagePlan);
			return result.finalApplyResult;
		}
		if (boundaryReached && stagePlan) {
			const stageResult = acknowledged.get(stagePlan.planId);
			if (stageResult) {
				remember(input.campId, stagePlan);
				return stageResult;
			}
		}
		if (result.refused)
			return unrealized(input.plan.planId, [
				"traffic-cutover-refused",
				...reasonCodes(result),
			]);
		if (result.rolledBack)
			return unrealized(input.plan.planId, [
				"traffic-cutover-rolled-back",
				...reasonCodes(result),
			]);

		const pendingId = result.pendingPlanId ?? input.plan.planId;
		const pendingPlan = result.plans.find((plan) => plan.planId === pendingId);
		if (pendingPlan) remember(input.campId, pendingPlan);
		return unrealized(
			parseRoutingPlanId(pendingId),
			["traffic-cutover-pending", ...reasonCodes(result)],
			"partial",
		);
	}

	return {
		offerings: async (campId) => (await d.routing(campId))?.offerings ?? [],
		shift,
		status: async (campId, planId): Promise<RoutingStatus | null> => {
			const context = await d.routing(campId);
			return context ? context.port.status(cutoverPlanId(planId)) : null;
		},
	};
}
