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
import {
	parseApplyResult,
	parseRoutingProvider,
	parseTrafficRoutingOfferingId,
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
import { isJsonObject, isJsonString } from "../rollout/json.js";
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

const CUTOVER_REASON_CODES = new Set([
	"apply-checkpoint-failed",
	"apply-degraded",
	"apply-identity-mismatch",
	"apply-observation-missing",
	"apply-outcome-unknown",
	"availability-context-changed",
	"availability-unsatisfied",
	"final-constraints-unsatisfied",
	"financial-supervisor-required",
	"health-evidence-missing",
	"health-evidence-stale",
	"health-gate-failed",
	"health-gate-missing",
	"health-outcome-unknown",
	"incumbent-artifact-invalid",
	"incumbent-artifact-missing",
	"incumbent-artifact-scope-mismatch",
	"incumbent-not-live",
	"incumbent-observation-failed",
	"invalid-hysteresis",
	"invalid-observation-freshness",
	"invalid-observation-window",
	"invalid-ramp",
	"policy-context-mismatch",
	"policy-denied",
	"policy-obligations-unsatisfied",
	"precondition-missing",
	"ramp-state-invalid",
	"resiliency-context-changed",
	"restoration-checkpoint-failed",
	"restoration-constraints-unsatisfied",
	"restoration-health-gate-missing",
	"restoration-health-unconfirmed",
	"restoration-unconfirmed",
	"station-missing",
	"ttl-invalid",
	"ttl-missing",
	"ttl-not-lowered",
	"ttl-wait-incomplete",
	"unknown-backend",
	"validation-unvalidated",
]);

function safeReasonCode(code: string): string {
	return CUTOVER_REASON_CODES.has(code)
		? code
		: "traffic-cutover-detail-unavailable";
}

function reasonCodes(result: RoutingCutoverResult): readonly string[] {
	return result.reasons.map((r) => safeReasonCode(r.code));
}

function safeFact(fact: DispatchFact): DispatchFact {
	if (!isJsonObject(fact.data)) return fact;
	if (fact.type === "resilience.Attempt" || fact.type === "resilience.Terminal")
		return {
			type: fact.type,
			data: { ...fact.data, reason: "Traffic provider request failed." },
		};
	if (!Array.isArray(fact.data.reasons)) return fact;
	const reasons = fact.data.reasons.map((entry) => ({
		code:
			isJsonObject(entry) && isJsonString(entry.code)
				? safeReasonCode(entry.code)
				: "traffic-cutover-detail-unavailable",
		message: "Traffic cutover did not complete.",
	}));
	return { type: fact.type, data: { ...fact.data, reasons } };
}

async function normalizedStatus(
	port: TrafficRoutingPort,
	planId: RoutingPlanId,
): Promise<RoutingStatus | null> {
	const result = await port.status(planId);
	if (result === null) return null;
	const active = result.active;
	const realized = result.realized;
	if (
		result.planId !== planId ||
		(active !== true && active !== false) ||
		(realized !== "full" && realized !== "partial" && realized !== "none")
	)
		throw new Error("Traffic provider status is unavailable.");
	return { planId, active, realized, notes: [] };
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
			const status = await normalizedStatus(context.port, plan.planId);
			if (status?.active === true && status.realized === "full") return plan;
		}
		return context.incumbentPlan;
	}

	async function shift(
		input: Readonly<{ campId: CampId; plan: RoutingPlan; signal: AbortSignal }>,
		_ctx: CdContext,
	): Promise<ApplyResult> {
		if (input.signal.aborted)
			return unrealized(input.plan.planId, ["traffic-shift-cancelled"]);
		const context = await d.routing(input.campId);
		if (input.signal.aborted)
			return unrealized(input.plan.planId, ["traffic-shift-cancelled"]);
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
		const verified = new Map<string, ApplyResult>();
		let boundaryReached = false;
		let applyingPhase: "ramp" | "restore" = "ramp";
		const provider = parseRoutingProvider(context.port.provider);
		const port: TrafficRoutingPort = {
			provider,
			async apply(plan) {
				if (applyingPhase === "ramp" && input.signal.aborted)
					throw new Error("Traffic shift was cancelled.");
				const raw = await context.port.apply(plan);
				if (
					!Array.isArray(raw.notes) ||
					(raw.unmet !== undefined && !Array.isArray(raw.unmet)) ||
					(raw.capabilities !== undefined && !Array.isArray(raw.capabilities))
				)
					throw new Error("Traffic provider response is invalid.");
				const result = parseApplyResult({
					planId: raw.planId,
					provider: raw.provider,
					realized: raw.realized,
					notes: [...raw.notes],
					...(raw.appliedRules === undefined
						? undefined
						: { appliedRules: raw.appliedRules }),
					...(raw.unmet === undefined ? undefined : { unmet: [...raw.unmet] }),
					...(raw.capabilities === undefined
						? undefined
						: { capabilities: [...raw.capabilities] }),
				});
				const realized = result.realized;
				if (
					result.planId !== plan.planId ||
					result.provider !== provider ||
					(realized !== "full" && realized !== "partial" && realized !== "none")
				)
					throw new Error("Traffic provider response is invalid.");
				verified.set(plan.planId, result);
				const normalized: ApplyResult = {
					planId: plan.planId,
					provider,
					realized,
					notes: [],
					...(result.appliedRules === undefined
						? undefined
						: { appliedRules: result.appliedRules }),
					...(result.unmet === undefined
						? undefined
						: {
								unmet: result.unmet.map(
									() => "Traffic provider requirement was not met.",
								),
							}),
					...(result.capabilities === undefined
						? undefined
						: { capabilities: result.capabilities }),
				};
				acknowledged.set(plan.planId, normalized);
				return normalized;
			},
			status: (planId) => normalizedStatus(context.port, planId),
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
			healthGate: (input) => {
				const applyResult = verified.get(input.plan.planId);
				if (!applyResult)
					throw new Error("Traffic acknowledgement is unavailable.");
				return context.healthGate({ ...input, applyResult });
			},
			restorationHealthGate: (input) => {
				const applyResult = verified.get(input.plan.planId);
				if (!applyResult)
					throw new Error("Traffic acknowledgement is unavailable.");
				return context.restorationHealthGate({ ...input, applyResult });
			},
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
			onFact: (fact) => d.onFact?.(input.campId, safeFact(fact)),
			async beforeApply(plan, phase, step) {
				if (phase === "ramp" && !toStable && step > percent) {
					boundaryReached = true;
					throw new StageBoundary(percent);
				}
				if (phase === "ramp" && input.signal.aborted)
					throw new Error("Traffic shift was cancelled.");
				await context.beforeApply(plan, phase, step);
				applyingPhase = phase;
			},
		});
		const stagePlan = result.plans.find(
			(plan) => plan.planId === cutoverPlanId(input.plan.planId),
		);
		if (result.ok && result.finalApplyResult) {
			if (stagePlan) remember(input.campId, stagePlan);
			return { ...result.finalApplyResult, planId: input.plan.planId };
		}
		if (boundaryReached && stagePlan) {
			const stageResult = acknowledged.get(stagePlan.planId);
			if (stageResult) {
				remember(input.campId, stagePlan);
				return { ...stageResult, planId: input.plan.planId };
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
			input.plan.planId,
			["traffic-cutover-pending", ...reasonCodes(result)],
			"partial",
		);
	}

	return {
		offerings: async (campId) => {
			try {
				const context = await d.routing(campId);
				return (
					context?.offerings.map((id) => parseTrafficRoutingOfferingId(id)) ??
					[]
				);
			} catch {
				throw new Error("Traffic offerings are unavailable.");
			}
		},
		shift: async (input, ctx) => {
			try {
				return await shift(input, ctx);
			} catch {
				throw new Error("Traffic shift is unavailable.");
			}
		},
		status: async (campId, planId): Promise<RoutingStatus | null> => {
			try {
				const context = await d.routing(campId);
				const status = context
					? await normalizedStatus(context.port, cutoverPlanId(planId))
					: null;
				return status ? { ...status, planId } : null;
			} catch {
				throw new Error("Traffic provider status is unavailable.");
			}
		},
	};
}
