import {
	type ApplyResult,
	type BackendRef,
	createTrafficRoutingMeteringEvent,
	type MeteringBus,
	type OverlayNetwork,
	parseApplyResult,
	parseRevokeResult,
	parseRoutingStatus,
	type RoutingPlan,
	type RoutingPlanId,
	type RoutingRule,
	type TrafficRoutingPort,
} from "@hobo/core";
import { cloneAsJson } from "../json.js";

export interface FunnelTrafficRouting extends TrafficRoutingPort {
	readonly provider: "funnel";
	readonly revoke: NonNullable<TrafficRoutingPort["revoke"]>;
	/**
	 * Weighted backend selection for an applied multi-backend plan.
	 * Public Funnel tip is the selected (or primary) backend's published host.
	 */
	select(
		planId: RoutingPlanId,
		routingKey: string,
		ruleIndex?: number,
	): BackendRef | null;
}

export interface FunnelTrafficRoutingOptions {
	readonly overlay: OverlayNetwork;
	readonly metering?: MeteringBus;
	/**
	 * When true, multi-backend plans require simultaneous multi-public Funnel
	 * hosts. Default false: weighted selection + single public tip is full.
	 */
	readonly requireMultiPublic?: boolean;
}

interface AppliedPlan {
	readonly plan: RoutingPlan;
	readonly result: ApplyResult;
	readonly primary: BackendRef;
}

export function createFunnelTrafficRouting(
	options: FunnelTrafficRoutingOptions,
): FunnelTrafficRouting {
	const applied = new Map<RoutingPlanId, AppliedPlan>();

	return {
		provider: "funnel",
		async apply(plan) {
			const unsupported = unsupportedFeatures(plan, options.requireMultiPublic);
			const rule = plan.intent.rules[0];
			const backends = rule?.backends ?? [];
			if (unsupported.length > 0 || backends.length === 0) {
				const result = resultFor(plan, "none", unsupported, [
					"Funnel cannot realize the declared routing plan shape",
				]);
				applied.set(plan.planId, {
					plan,
					result,
					// SAFETY: assertion required at this I/O or test boundary.
					primary: backends[0] as BackendRef,
				});
				await meter(options.metering, plan, "deny");
				return result;
			}
			if (!options.overlay.publishFunnel) {
				const result = resultFor(
					plan,
					"none",
					["overlay.publishFunnel"],
					["overlay provider does not support Funnel"],
				);
				applied.set(plan.planId, {
					plan,
					result,
					// SAFETY: assertion required at this I/O or test boundary.
					primary: backends[0] as BackendRef,
				});
				await meter(options.metering, plan, "deny");
				return result;
			}

			// Weighted selection among backends; public tip is highest-weight primary
			// (deterministic first backend after weight sort for stable gateway).
			// SAFETY: assertion required at this I/O or test boundary.
			const primary = primaryBackend(rule as RoutingRule);
			if (!primary?.endpoint || !isLocalFunnelTarget(primary.endpoint)) {
				const result = resultFor(
					plan,
					"none",
					["backend-target"],
					["Funnel public tip requires a local HTTP(S) backend endpoint"],
				);
				applied.set(plan.planId, {
					plan,
					result,
					// SAFETY: assertion required at this I/O or test boundary.
					primary: primary as BackendRef,
				});
				await meter(options.metering, plan, "deny");
				return result;
			}

			try {
				const published = await options.overlay.publishFunnel({
					tenantId: plan.intent.tenantId,
					backendUrl: primary.endpoint,
					hostnameHint: plan.intent.service,
				});
				const multiNote =
					backends.length > 1
						? [
								`multi-backend weighted selection among ${backends.length} backends; public Funnel tip is ${primary.id}`,
							]
						: [];
				const realized =
					!published.enabled || published.confirmed !== true
						? "none"
						: published.gatewayHostname
							? "full"
							: "partial";
				const unmet =
					realized === "full"
						? []
						: [
								realized === "partial"
									? "gateway-hostname"
									: published.enabled
										? "funnel-unconfirmed"
										: "funnel-unavailable",
							];
				const result = resultFor(
					plan,
					realized,
					unmet,
					realized === "full"
						? [
								...published.notes,
								...multiNote,
								`Funnel gateway: ${published.gatewayHostname}`,
							]
						: [...published.notes, ...multiNote],
					backends.length > 1 ? ["weighted-backends"] : ["weighted-backends"],
				);
				applied.set(plan.planId, { plan, result, primary });
				await meter(
					options.metering,
					plan,
					realized === "full"
						? "apply"
						: realized === "partial"
							? "degraded"
							: "deny",
				);
				return result;
			} catch {
				const result = resultFor(
					plan,
					"none",
					["provider-error"],
					["Funnel publish failed"],
				);
				applied.set(plan.planId, {
					plan,
					result,
					primary,
				});
				await meter(options.metering, plan, "deny");
				return result;
			}
		},
		async status(planId) {
			const current = applied.get(planId);
			if (!current) return null;
			return parseRoutingStatus(
				cloneAsJson({
					planId,
					active: current.result.realized !== "none",
					realized: current.result.realized,
					notes: current.result.notes,
				}),
			);
		},
		select(planId, routingKey, ruleIndex = 0) {
			const current = applied.get(planId);
			if (!current || current.result.realized === "none") return null;
			const rule = current.plan.intent.rules[ruleIndex];
			if (!rule) return null;
			return selectBackend(rule, routingKey);
		},
		async revoke(planId) {
			const current = applied.get(planId);
			if (!current) {
				return parseRevokeResult(
					cloneAsJson({
						ok: false,
						notes: ["routing plan not found"],
					}),
				);
			}
			if (current.result.realized === "none") {
				return parseRevokeResult(
					cloneAsJson({
						ok: true,
						notes: ["no route was realized"],
					}),
				);
			}
			return parseRevokeResult(
				cloneAsJson({
					ok: false,
					notes: ["overlay does not expose Funnel revoke"],
				}),
			);
		},
	};
}

function unsupportedFeatures(
	plan: RoutingPlan,
	requireMultiPublic: boolean | undefined,
): string[] {
	const unmet: string[] = [];
	if (plan.intent.rules.length !== 1) unmet.push("multiple-rules");
	const rule = plan.intent.rules[0];
	if (!rule) {
		unmet.push("backends");
		return unmet;
	}
	if (rule.backends.length === 0) unmet.push("backends");
	if (rule.weightStrategy !== "static") {
		unmet.push(`weightStrategy:${rule.weightStrategy}`);
	}
	if (rule.match?.pathPrefix) unmet.push("path-prefix");
	if (rule.match?.headers) unmet.push("header-match");
	for (const [index, backend] of rule.backends.entries()) {
		if (!backend.endpoint) unmet.push(`backends[${index}].endpoint`);
		else if (!isLocalFunnelTarget(backend.endpoint)) {
		}
	}
	if (
		rule.backends.length > 0 &&
		rule.backends.every(
			(backend) => !backend.endpoint || !isLocalFunnelTarget(backend.endpoint),
		)
	) {
		unmet.push("backend-target");
	}
	if (requireMultiPublic === true && rule.backends.length > 1) {
		unmet.push("funnel-multi-public");
	}
	if (plan.intent.availability) unmet.push("availability-constraints");
	if (plan.intent.resiliency) unmet.push("resiliency");
	return [...new Set(unmet)];
}

function primaryBackend(rule: RoutingRule): BackendRef | null {
	const local = rule.backends.filter(
		(backend) => backend.endpoint && isLocalFunnelTarget(backend.endpoint),
	);
	const candidates = local.length > 0 ? local : [...rule.backends];
	if (candidates.length === 0) return null;
	// SAFETY: assertion required at this I/O or test boundary.
	return [...candidates].sort(
		(left, right) => (right.weight ?? 1) - (left.weight ?? 1),
	)[0] as BackendRef;
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

function isLocalFunnelTarget(endpoint: string): boolean {
	const url = new URL(endpoint);
	return new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname);
}

function resultFor(
	plan: RoutingPlan,
	realized: "full" | "partial" | "none",
	unmet: readonly string[],
	notes: readonly string[],
	capabilities: readonly "weighted-backends"[] = ["weighted-backends"],
) {
	return parseApplyResult(
		cloneAsJson({
			planId: plan.planId,
			provider: "funnel",
			realized,
			notes,
			appliedRules: realized === "none" ? 0 : 1,
			...(unmet.length === 0 ? undefined : { unmet: [...new Set(unmet)] }),
			capabilities: realized === "none" ? [] : [...capabilities],
		}),
	);
}

async function meter(
	metering: MeteringBus | undefined,
	plan: RoutingPlan,
	outcome: "apply" | "degraded" | "deny",
) {
	try {
		await metering?.emit(
			createTrafficRoutingMeteringEvent({
				tenantId: plan.intent.tenantId,
				planId: plan.planId,
				provider: "funnel",
				outcome,
			}),
		);
	} catch {
		// Provider realization remains authoritative when observation delivery fails.
	}
}
