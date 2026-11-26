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
import { cloneAsJson, type JsonObject } from "../json.js";

/** Minimal driver-program shape emitted for Lakebed deploy-time binding. */
export interface LakebedTrafficDriverProgram {
	readonly apiVersion: "hobo.driver-program/v1";
	readonly kind: "driver-program";
	readonly driver: "lakebed-deploy";
	readonly deploymentId: string;
	readonly capsule: string;
	readonly resources: readonly {
		readonly name: string;
		readonly type: "lakebed:traffic-route";
		readonly provider: "lakebed";
		readonly inputs: JsonObject;
		readonly outputs: readonly string[];
	}[];
	readonly outputs: Readonly<Record<string, string>>;
}

export interface LakebedTrafficDeployOptions {
	/** Capsule name for the driver program (default derived from plan service). */
	readonly capsule?: string;
	readonly deploymentId?: string;
	/**
	 * Apply a realized `hobo.driver-program/v1` with a `lakebed:traffic-route`
	 * resource. Injected so `@hobo/connectivity` stays free of provider package deps.
	 */
	readonly applyDriverProgram?: (
		program: LakebedTrafficDriverProgram,
	) => Promise<{ readonly ok: boolean; readonly notes?: readonly string[] }>;
}

export interface LakebedTrafficRouting extends TrafficRoutingPort {
	readonly provider: "lakebed";
	readonly revoke: NonNullable<TrafficRoutingPort["revoke"]>;
	/**
	 * Deterministic weighted backend selection for an applied plan (in-process
	 * production router for the closed Lakebed Capsule runtime).
	 */
	select(
		planId: RoutingPlanId,
		routingKey: string,
		ruleIndex?: number,
	): BackendRef | null;
	/** Last deploy-time driver program emitted for a plan, when deploy is configured. */
	driverProgram(planId: RoutingPlanId): LakebedTrafficDriverProgram | null;
}

export interface LakebedTrafficRoutingOptions {
	readonly metering?: MeteringBus;
	/** Optional deploy-time domain/capsule binding layer. */
	readonly deploy?: LakebedTrafficDeployOptions;
}

interface AppliedPlan {
	readonly plan: RoutingPlan;
	readonly result: ApplyResult;
	readonly program: LakebedTrafficDriverProgram | null;
	revoked: boolean;
}

/**
 * Production Lakebed TrafficRouting adapter (dual layer).
 *
 * 1. In-process weighted router over capsule endpoint URLs — full realization
 *    for static multi-backend plans (Lakebed has no public multi-LB API).
 * 2. Optional deploy-time `lakebed:traffic-route` driver program binding when
 *    `deploy.applyDriverProgram` is configured.
 */
export function createLakebedTrafficRouting(
	options: LakebedTrafficRoutingOptions = {},
): LakebedTrafficRouting {
	const applied = new Map<RoutingPlanId, AppliedPlan>();

	return {
		provider: "lakebed",
		async apply(plan) {
			const unmet = unsupported(plan);
			const canRealize = realizedRuleCount(plan) > 0;
			if (!canRealize) {
				const result = parseApplyResult(
					cloneAsJson({
						planId: plan.planId,
						provider: "lakebed",
						realized: "none",
						notes: ["Lakebed cannot realize the declared routing plan shape"],
						appliedRules: 0,
						unmet,
						capabilities: [],
					}),
				);
				applied.set(plan.planId, {
					plan,
					result,
					program: null,
					revoked: false,
				});
				await meter(options.metering, plan, "deny");
				return result;
			}

			const program = options.deploy
				? buildTrafficRouteProgram(plan, options.deploy)
				: null;
			const deployNotes: string[] = [];
			let deployFailed = false;
			if (program && options.deploy?.applyDriverProgram) {
				try {
					const deployResult = await options.deploy.applyDriverProgram(program);
					if (!deployResult.ok) {
						deployFailed = true;
						deployNotes.push(
							...(deployResult.notes ?? ["lakebed deploy binding failed"]),
						);
					}
				} catch (error) {
					deployFailed = true;
					deployNotes.push(
						error instanceof Error
							? error.message
							: "lakebed deploy binding failed",
					);
				}
			}

			const layerUnmet = [
				...unmet,
				...(deployFailed ? ["deploy-binding"] : []),
			];
			const realized =
				layerUnmet.length === 0 && !deployFailed
					? "full"
					: canRealize
						? "partial"
						: "none";
			const result = parseApplyResult(
				cloneAsJson({
					planId: plan.planId,
					provider: "lakebed",
					realized,
					notes:
						realized === "full"
							? []
							: [
									...(unmet.length > 0
										? [
												"unsupported routing features use declared backend order",
											]
										: []),
									...deployNotes,
								],
					appliedRules: realizedRuleCount(plan),
					...(layerUnmet.length === 0
						? undefined
						: { unmet: [...new Set(layerUnmet)] }),
					capabilities: ["weighted-backends"],
				}),
			);
			applied.set(plan.planId, {
				plan,
				result,
				program,
				revoked: false,
			});
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
		},
		async status(planId) {
			const current = applied.get(planId);
			if (!current) return null;
			if (current.revoked) {
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
					active: current.result.realized !== "none",
					realized: current.result.realized,
					notes: current.result.notes,
				}),
			);
		},
		select(planId, routingKey, ruleIndex = 0) {
			const current = applied.get(planId);
			if (!current || current.revoked) return null;
			if (current.result.realized === "none") return null;
			const rule = current.plan.intent.rules[ruleIndex];
			if (!rule) return null;
			return selectBackend(rule, routingKey);
		},
		driverProgram(planId) {
			const current = applied.get(planId);
			if (!current || current.revoked) return null;
			return current.program;
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
			current.revoked = true;
			return parseRevokeResult(cloneAsJson({ ok: true, notes: [] }));
		},
	};
}

/** Build the deploy-time traffic-route driver program (shared shape with provider-lakebed). */
export function buildTrafficRouteProgram(
	plan: RoutingPlan,
	deploy: LakebedTrafficDeployOptions = {},
): LakebedTrafficDriverProgram {
	const deploymentId =
		deploy.deploymentId?.trim() || sanitize(plan.planId) || "traffic";
	const capsule =
		deploy.capsule?.trim() ||
		`capsule/${sanitize(plan.intent.service) || "service"}`;
	const resourceName = `route-${sanitize(plan.planId)}`;
	return {
		apiVersion: "hobo.driver-program/v1",
		kind: "driver-program",
		driver: "lakebed-deploy",
		deploymentId,
		capsule,
		resources: [
			{
				name: resourceName,
				type: "lakebed:traffic-route",
				provider: "lakebed",
				inputs: {
					planId: plan.planId,
					service: plan.intent.service,
					tenantId: plan.intent.tenantId,
					backends: plan.backends.map((backend) => ({
						id: backend.id,
						service: backend.service,
						...(backend.endpoint === undefined
							? undefined
							: { endpoint: backend.endpoint }),
						...(backend.weight === undefined
							? undefined
							: { weight: backend.weight }),
						...(backend.locationHints === undefined
							? undefined
							: { locationHints: [...backend.locationHints] }),
					})),
					rules: plan.intent.rules.map((rule) => ({
						weightStrategy: rule.weightStrategy,
						...(rule.match
							? {
									match: {
										...(rule.match.pathPrefix
											? { pathPrefix: rule.match.pathPrefix }
											: undefined),
										...(rule.match.headers
											? { headers: { ...rule.match.headers } }
											: undefined),
									},
								}
							: undefined),
						backends: rule.backends.map((backend) => backend.id),
					})),
				},
				outputs: ["routeId", "binding"],
			},
		],
		outputs: {
			routeId: `\${resources.${resourceName}.outputs.routeId}`,
			binding: `\${resources.${resourceName}.outputs.binding}`,
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
		for (const [backendIndex, backend] of rule.backends.entries()) {
			if (!backend.endpoint) {
				unmet.push(`rules[${index}].backends[${backendIndex}].endpoint`);
			}
		}
	}
	if (plan.intent.availability) unmet.push("availability-constraints");
	if (plan.intent.resiliency) unmet.push("resiliency");
	return [...new Set(unmet)];
}

function realizedRuleCount(plan: RoutingPlan): number {
	if (plan.intent.rules.length !== 1) return 0;
	const rule = plan.intent.rules[0];
	if (!rule) return 0;
	if (rule.weightStrategy !== "static") return 0;
	if (rule.match?.pathPrefix || rule.match?.headers) return 0;
	if (rule.backends.some((backend) => !backend.endpoint)) return 0;
	return 1;
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

function sanitize(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
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
				provider: "lakebed",
				outcome,
			}),
		);
	} catch {
		// Applied state remains authoritative when observation delivery fails.
	}
}
