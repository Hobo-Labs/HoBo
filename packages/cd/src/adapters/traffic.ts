// TrafficShifter over Station cutover (D8: executeRoutingCutover is the only
// caller of TrafficRoutingPort.apply). The orchestrator asks for a neutral
// stage split between the `stable` and `candidate` cohorts (rollout/routing.ts);
// this adapter maps the cohorts onto the Camp's real backends from its Station
// routing context and realizes the split through one cutover:
//
//   0 < P < 100   stable → candidate, ramp [P, 100], stopped at P
//   P = 100       stable → candidate, ramp [100]
//   P = 0         candidate → stable, ramp [100]   (zero exposure, D12)
//
// A cutover always ramps to 100, so a stage stops at P through the cutover's
// own durable-supervisor hook: `beforeApply` refuses the checkpoint of any step
// beyond P, which happens before that step's provider write. The cutover
// therefore applies, observes and health-gates P, then returns without
// touching the provider again; the adapter reports P's acknowledged result.
//
// Every cutover precondition (validated change, TTL evidence for DNS, the exact
// incumbent plan, financial checkpoint, destination and restoration health
// gates) comes from the composed context and is enforced by the cutover.
import type {
	ApplyResult,
	PolicyDecision,
	RoutingPlan,
	RoutingPlanId,
	RoutingStatus,
	TrafficRoutingOfferingId,
	TrafficRoutingPort,
} from "@hobo/core";
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

/** Everything Station cutover needs for one Camp, composed by the Station host (WP18). */
export type CampRoutingContext = Readonly<{
	port: TrafficRoutingPort;
	/** Offerings the Camp's provider profile declares (TrafficRoutingProviderProfile). */
	offerings: readonly TrafficRoutingOfferingId[];
	topology: RoutingTopology;
	policyDecision: PolicyDecision;
	/** The backend serving the current (stable) version. */
	stableBackendId: string;
	/** The backend serving the promoted (candidate) version. */
	candidateBackendId: string;
	/** Validated change and DNS evidence; the incumbent plan is tracked here. */
	precondition: Omit<CutoverPrecondition, "incumbentPlan" | "incumbentPlanId">;
	/** The live plan before this rollout touched the Camp. */
	incumbentPlan: RoutingPlan;
	healthGate: CutoverHealthGate;
	restorationHealthGate: CutoverHealthGate;
	/** Financial admission and durable intent checkpoint before each provider write. */
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
	/** Cutover facts (domain.CutoverStarted, routing.RampAdvanced, …) for the Station journal. */
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

/**
 * The cutover plan that realizes a stage plan: the cutover names its plans
 * `<prefix>:p<step>`, and a stage stops at its own percent (zero exposure is
 * the 100 step of the reverse cutover). Status is always read by stage plan id.
 */
export function cutoverPlanId(stagePlanId: string): RoutingPlanId {
	const match = /:p(\d+)$/.exec(stagePlanId);
	const percent = match ? Number(match[1]) : 100;
	// SAFETY: the cutover's own plan id convention (planIdPrefix + ":p" + step).
	return `${stagePlanId}:p${percent === 0 ? 100 : percent}` as RoutingPlanId;
}

function reasonCodes(result: RoutingCutoverResult): readonly string[] {
	return result.reasons.map((r) => `${r.code}: ${r.message}`);
}

export function createCutoverTrafficShifter(
	d: CutoverTrafficShifterDeps,
): TrafficShifter {
	/** Plans each Camp's cutovers applied, oldest first: incumbent candidates. */
	const history = new Map<CampId, RoutingPlan[]>();
	const remember = (campId: CampId, plan: RoutingPlan) => {
		history.set(campId, [...(history.get(campId) ?? []), plan].slice(-8));
	};

	/**
	 * The incumbent is resolved by observation, never assumed: the newest plan
	 * the port reports active and fully realized (a pending write may or may not
	 * have landed), else the composed live plan.
	 */
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
		// Ambiguous provider outcome: resolved by observation only (I5), never a blind retry.
		const pendingId = result.pendingPlanId ?? input.plan.planId;
		const pendingPlan = result.plans.find((plan) => plan.planId === pendingId);
		if (pendingPlan) remember(input.campId, pendingPlan);
		return unrealized(
			// SAFETY: the pending plan id is the cutover's own plan id.
			pendingId as RoutingPlanId,
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
