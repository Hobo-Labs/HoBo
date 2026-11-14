// The neutral traffic intent of one rollout stage. The orchestrator never
// knows provider backends: it asks for a weight split between two cohorts,
// `stable` and `candidate`, as a core RoutingPlan. The Station adapter
// (adapters/traffic.ts) maps the cohorts onto the Camp's real backends and
// realizes the split through Station cutover, the only caller of
// TrafficRoutingPort.apply (D8).
import {
	parseRoutingPlan,
	parseTenantId,
	type RoutingPlan,
	type RoutingPlanId,
} from "@hobo/core";
import type { CampId, RolloutId } from "../ports.js";

// public-contract: cohort backend ids of a stage RoutingPlan.
export const STAGE_BACKENDS = Object.freeze({
	stable: "stable",
	candidate: "candidate",
} as const);

/** Deterministic plan id: one per rollout, Camp and percent. */
export function stagePlanId(
	rolloutId: RolloutId,
	campId: CampId,
	percent: number,
): RoutingPlanId {
	// SAFETY: a RoutingPlanId is any non-empty token; parseRoutingPlan re-checks it below.
	return `${rolloutId}:${campId}:p${percent}` as RoutingPlanId;
}

/** The RoutingPlan that puts `percent` of the Camp's traffic on the candidate. */
export function stageRoutingPlan(
	input: Readonly<{
		rolloutId: RolloutId;
		campId: CampId;
		tenant: string;
		percent: number;
		atMs: number;
	}>,
): RoutingPlan {
	const percent = Math.max(0, Math.min(100, Math.round(input.percent)));
	// Weights are positive integers on the wire: a cohort at 0% is omitted.
	const backends = [
		{ id: STAGE_BACKENDS.stable, service: input.campId, weight: 100 - percent },
		{ id: STAGE_BACKENDS.candidate, service: input.campId, weight: percent },
	].filter((backend) => backend.weight > 0);
	return parseRoutingPlan({
		planId: stagePlanId(input.rolloutId, input.campId, percent),
		intent: {
			service: input.campId,
			tenantId: parseTenantId(input.tenant),
			rules: [{ backends, weightStrategy: "static" }],
		},
		backends,
		createdAt: new Date(input.atMs).toISOString(),
	});
}

/** The candidate share (0–100) a stage plan asks for; undefined when it is not a stage plan. */
export function stageShare(plan: RoutingPlan): number | undefined {
	const candidate = plan.backends.find(
		(backend) => backend.id === STAGE_BACKENDS.candidate,
	);
	const stable = plan.backends.find(
		(backend) => backend.id === STAGE_BACKENDS.stable,
	);
	if (!candidate && !stable) return undefined;
	if (
		plan.backends.some(
			(backend) =>
				backend.id !== STAGE_BACKENDS.candidate &&
				backend.id !== STAGE_BACKENDS.stable,
		)
	)
		return undefined;
	const share = candidate?.weight ?? 0;
	const total = share + (stable?.weight ?? 0);
	return total > 0 ? Math.round((share * 100) / total) : undefined;
}
