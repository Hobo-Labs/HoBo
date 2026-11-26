import {
	type ApplyResult,
	type BackendRef,
	createTrafficRoutingMeteringEvent,
	type MeteringBus,
	parseApplyResult,
	parseRevokeResult,
	parseRoutingStatus,
	type RoutingPlan,
	type RoutingPlanId,
	type RoutingRule,
	type TrafficRoutingPort,
} from "@hobo/core";
import { cloneAsJson } from "../json.js";

export interface SimpleTrafficRouting extends TrafficRoutingPort {
	readonly provider: "simple";
	select(
		planId: RoutingPlanId,
		routingKey: string,
		ruleIndex?: number,
	): BackendRef | null;
	readonly revoke: NonNullable<TrafficRoutingPort["revoke"]>;
}

export function createSimpleTrafficRouting(options?: {
	readonly metering?: MeteringBus;
}): SimpleTrafficRouting {
	const plans = new Map<RoutingPlanId, RoutingPlan>();
	const results = new Map<RoutingPlanId, ApplyResult>();
	const revoked = new Set<RoutingPlanId>();

	return {
		provider: "simple",
		async apply(plan) {
			const unmet = unsupported(plan);
			const realized = unmet.length === 0 ? "full" : "partial";
			const result = parseApplyResult(
				cloneAsJson({
					planId: plan.planId,
					provider: "simple",
					realized,
					notes:
						realized === "full"
							? []
							: ["unsupported routing features use declared backend order"],
					appliedRules: realizedRuleCount(plan),
					...(unmet.length === 0 ? undefined : { unmet }),
					capabilities: ["weighted-backends"],
				}),
			);
			plans.set(plan.planId, plan);
			results.set(plan.planId, result);
			revoked.delete(plan.planId);
			try {
				await options?.metering?.emit(
					createTrafficRoutingMeteringEvent({
						tenantId: plan.intent.tenantId,
						planId: plan.planId,
						provider: "simple",
						outcome: realized === "full" ? "apply" : "degraded",
					}),
				);
			} catch {
				// Applied state remains authoritative when observation delivery fails.
			}
			return result;
		},
		async status(planId) {
			const result = results.get(planId);
			if (!result) return null;
			if (revoked.has(planId)) {
				return parseRoutingStatus(
					cloneAsJson({
						planId,
						active: false,
						realized: "none",
						notes: ["routing plan revoked"],
					}),
				);
			}
			return parseRoutingStatus(
				cloneAsJson({
					planId,
					active: true,
					realized: result.realized,
					notes: result.notes,
				}),
			);
		},
		select(planId, routingKey, ruleIndex = 0) {
			if (revoked.has(planId)) return null;
			const rule = plans.get(planId)?.intent.rules[ruleIndex];
			if (!rule) return null;
			return selectBackend(rule, routingKey);
		},
		async revoke(planId) {
			if (!plans.has(planId)) {
				return parseRevokeResult(
					cloneAsJson({
						ok: false,
						notes: ["routing plan not found"],
					}),
				);
			}
			revoked.add(planId);
			return parseRevokeResult(cloneAsJson({ ok: true, notes: [] }));
		},
	};
}

function unsupported(plan: RoutingPlan): string[] {
	const unmet = plan.intent.rules
		.filter(({ weightStrategy }) => weightStrategy !== "static")
		.map(({ weightStrategy }) => `weightStrategy:${weightStrategy}`);
	if (plan.intent.rules.length > 1) unmet.push("multiple-rules");
	for (const [index, rule] of plan.intent.rules.entries()) {
		if (rule.match?.pathPrefix) unmet.push(`rules[${index}].path-prefix`);
		if (rule.match?.headers) unmet.push(`rules[${index}].header-match`);
	}
	if (plan.intent.availability) unmet.push("availability-constraints");
	if (plan.intent.resiliency) unmet.push("resiliency");
	return [...new Set(unmet)];
}

function realizedRuleCount(plan: RoutingPlan): number {
	if (plan.intent.rules.length !== 1) return 0;
	const rule = plan.intent.rules[0];
	return rule &&
		rule.weightStrategy === "static" &&
		!rule.match?.pathPrefix &&
		!rule.match?.headers
		? 1
		: 0;
}

function selectBackend(
	rule: RoutingRule,
	routingKey: string,
): BackendRef | null {
	const first = rule.backends[0];
	if (!first) return null;
	if (rule.weightStrategy !== "static") return first;
	const total = rule.backends.reduce(
		(sum, backend) => sum + (backend.weight ?? 1),
		0,
	);
	let bucket = stableHash(routingKey) % total;
	for (const backend of rule.backends) {
		bucket -= backend.weight ?? 1;
		if (bucket < 0) return backend;
	}
	return first;
}

function stableHash(value: string): number {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}
