import {
	type ApplyResult,
	createTrafficRoutingMeteringEvent,
	type MeteringBus,
	parseApplyResult,
	parseRevokeResult,
	parseRoutingStatus,
	type RoutingPlan,
	type RoutingPlanId,
	type RoutingRule,
	type TrafficRoutingCapability,
	type TrafficRoutingPort,
} from "@hobo/core";
import {
	cloneAsJson,
	isJsonBoolean,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";

export interface CloudflareBackendHealthObservation {
	readonly backendId: string;
	readonly healthy?: boolean;
	readonly poolId?: string;
	readonly notes?: readonly string[];
}

export interface CloudflareTrafficRouting extends TrafficRoutingPort {
	readonly provider: "cloudflare";
	readonly revoke: NonNullable<TrafficRoutingPort["revoke"]>;
	/**
	 * observe.health: fetch pool health for an applied plan (or explicit pool map).
	 * Returns empty when credentials/account/pools are unavailable.
	 */
	observeHealth(
		planId: RoutingPlanId,
		poolIdsByBackend?: Readonly<Record<string, string>>,
	): Promise<readonly CloudflareBackendHealthObservation[]>;
}

export interface CloudflareTrafficRoutingOptions {
	/** API token with Load Balancing edit permission. Never logged or metered. */
	readonly apiToken?: string;
	readonly zoneId: string;
	/**
	 * Account id for pool create (POST /accounts/{id}/load_balancers/pools).
	 * Required when backends are not pre-mapped via `poolIdsByBackend`.
	 */
	readonly accountId?: string;
	/** Existing Cloudflare pool IDs keyed by HoBo backend ID (brownfield). */
	readonly poolIdsByBackend?: Readonly<Record<string, string>>;
	/** Existing Cloudflare load-balancer IDs keyed by HoBo plan ID (brownfield). */
	readonly loadBalancerIdsByPlan?: Readonly<Record<string, string>>;
	/**
	 * Delete pools created by this adapter on revoke. Default false (retain pools).
	 * Pre-mapped brownfield pools are never deleted.
	 */
	readonly deleteCreatedPoolsOnRevoke?: boolean;
	/** True only when every mapped/created pool has an independently configured monitor. */
	readonly healthChecksConfigured?: boolean;
	readonly apiBase?: string;
	readonly fetchImpl?: typeof fetch;
	readonly metering?: MeteringBus;
}

interface AppliedPlan {
	readonly externalId: string;
	readonly plan: RoutingPlan;
	readonly fingerprint: string;
	readonly expected: ReturnType<typeof cloudflareLoadBalancer>;
	readonly result: ApplyResult;
	readonly createdLoadBalancer: boolean;
	readonly createdPoolIds: readonly string[];
	readonly poolIdsByBackend: Readonly<Record<string, string>>;
	revoked: boolean;
}

export function createCloudflareTrafficRouting(
	options: CloudflareTrafficRoutingOptions,
): CloudflareTrafficRouting {
	const token = options.apiToken?.trim();
	const base = (
		options.apiBase ?? "https://api.cloudflare.com/client/v4"
	).replace(/\/+$/u, "");
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const applied = new Map<RoutingPlanId, AppliedPlan>();

	async function request(path: string, init?: RequestInit) {
		if (!token || !fetchImpl) return { ok: false, status: 0, body: null };
		try {
			const response = await fetchImpl(`${base}${path}`, {
				...init,
				headers: {
					accept: "application/json",
					authorization: `Bearer ${token}`,
					...(init?.body === undefined
						? undefined
						: { "content-type": "application/json" }),
					...headersObject(init?.headers),
				},
			});
			return {
				ok: response.ok,
				status: response.status,
				// SAFETY: assertion required at this I/O or test boundary.
				body: cloneAsJson(await response.json().catch(() => null)),
			};
		} catch {
			return { ok: false, status: 0, body: null };
		}
	}

	return {
		provider: "cloudflare",
		async apply(plan) {
			if (!token) {
				const result = resultFor(
					plan,
					"none",
					0,
					["credentials"],
					["Cloudflare API token is required"],
				);
				await meter(options.metering, plan, "deny");
				return result;
			}
			if (!isDnsHostname(plan.intent.service)) {
				const result = resultFor(
					plan,
					"none",
					0,
					["service-hostname"],
					["Cloudflare load balancers require a DNS hostname"],
				);
				await meter(options.metering, plan, "deny");
				return result;
			}
			const fingerprint = JSON.stringify(plan);
			const previous = applied.get(plan.planId);
			if (
				previous &&
				!previous.revoked &&
				previous.fingerprint !== fingerprint
			) {
				const result = resultFor(
					plan,
					"none",
					0,
					["plan-id-conflict"],
					["planId is already active with different routing content"],
				);
				await meter(options.metering, plan, "deny");
				return result;
			}

			const { rule, unmet } = supportedRule(
				plan,
				options.healthChecksConfigured === true,
			);
			if (!rule) {
				const result = resultFor(plan, "none", 0, unmet, [
					"Cloudflare cannot safely realize the declared routing matches",
				]);
				await meter(options.metering, plan, "deny");
				return result;
			}

			const poolResolution = await resolveOrCreatePools(rule, options, request);
			if (poolResolution.ok === false) {
				const result = resultFor(
					plan,
					"none",
					0,
					[...unmet, ...poolResolution.unmet],
					poolResolution.notes,
				);
				await meter(options.metering, plan, "deny");
				return result;
			}

			const expected = cloudflareLoadBalancer(
				plan,
				rule,
				poolResolution.poolIds,
			);
			const mappedLb = options.loadBalancerIdsByPlan?.[plan.planId]?.trim();
			let externalId = mappedLb;
			let createdLoadBalancer = false;
			let response: { ok: boolean; status: number; body: JsonValue };

			if (externalId) {
				response = await request(
					`/zones/${encodeURIComponent(options.zoneId)}/load_balancers/${encodeURIComponent(externalId)}`,
					{ method: "PUT", body: JSON.stringify(expected) },
				);
			} else {
				response = await request(
					`/zones/${encodeURIComponent(options.zoneId)}/load_balancers`,
					{ method: "POST", body: JSON.stringify(expected) },
				);
				const createdId = cloudflareResultId(response.body);
				if (response.ok && cloudflareSuccess(response.body) && createdId) {
					externalId = createdId;
					createdLoadBalancer = true;
				}
			}

			if (!externalId || !response.ok || !cloudflareSuccess(response.body)) {
				const result = resultFor(
					plan,
					"none",
					0,
					["provider-api"],
					[providerFailure("apply", response.status)],
				);
				await meter(options.metering, plan, "deny");
				return result;
			}

			const realized = unmet.length === 0 ? "full" : "partial";
			const result = resultFor(
				plan,
				realized,
				1,
				unmet,
				realized === "full"
					? createdLoadBalancer
						? ["Cloudflare load balancer created"]
						: []
					: ["Cloudflare applied the provider-safe subset of the routing plan"],
				capabilitiesFor(rule, options.healthChecksConfigured === true),
			);
			const poolIdsByBackend: Record<string, string> = {};
			for (const [index, backend] of rule.backends.entries()) {
				const poolId = poolResolution.poolIds[index];
				if (poolId) poolIdsByBackend[backend.id] = poolId;
			}
			applied.set(plan.planId, {
				externalId,
				plan,
				fingerprint,
				expected,
				result,
				createdLoadBalancer,
				createdPoolIds: poolResolution.createdPoolIds,
				poolIdsByBackend,
				revoked: false,
			});
			await meter(
				options.metering,
				plan,
				realized === "full" ? "apply" : "degraded",
			);
			return result;
		},
		async observeHealth(planId, poolIdsByBackend) {
			const current = applied.get(planId);
			const map =
				poolIdsByBackend ??
				current?.poolIdsByBackend ??
				options.poolIdsByBackend ??
				{};
			const accountId = options.accountId?.trim();
			if (!token || !accountId) return [];
			const observations: CloudflareBackendHealthObservation[] = [];
			for (const [backendId, poolId] of Object.entries(map)) {
				if (!poolId?.trim()) continue;
				const response = await request(
					`/accounts/${encodeURIComponent(accountId)}/load_balancers/pools/${encodeURIComponent(poolId.trim())}/health`,
				);
				if (!response.ok || !cloudflareSuccess(response.body)) {
					observations.push({
						backendId,
						poolId: poolId.trim(),
						notes: [providerFailure("pool-health", response.status)],
					});
					continue;
				}
				const healthy = cloudflarePoolHealthy(response.body);
				observations.push({
					backendId,
					poolId: poolId.trim(),
					...(healthy === undefined ? undefined : { healthy }),
				});
			}
			return observations;
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
			const response = await request(
				`/zones/${encodeURIComponent(options.zoneId)}/load_balancers/${encodeURIComponent(current.externalId)}`,
			);
			if (!response.ok || !cloudflareSuccess(response.body)) {
				return parseRoutingStatus(
					cloneAsJson({
						planId,
						active: false,
						realized: "partial",
						notes: [providerFailure("status", response.status)],
					}),
				);
			}
			const active = cloudflareEnabled(response.body);
			const matches =
				active && cloudflareObservedMatches(response.body, current.expected);
			return parseRoutingStatus(
				cloneAsJson({
					planId,
					active,
					realized: !active
						? "none"
						: matches
							? current.result.realized
							: "partial",
					notes: !active
						? ["Cloudflare route is disabled"]
						: matches
							? current.result.notes
							: ["Cloudflare observed configuration does not match the plan"],
				}),
			);
		},
		async revoke(planId) {
			if (!token) {
				return parseRevokeResult(
					cloneAsJson({
						ok: false,
						notes: ["Cloudflare API token is required"],
					}),
				);
			}
			const current = applied.get(planId);
			if (!current) {
				return parseRevokeResult(
					cloneAsJson({
						ok: false,
						notes: ["routing plan not found"],
					}),
				);
			}
			if (current.revoked)
				return parseRevokeResult(cloneAsJson({ ok: true, notes: [] }));
			const response = await request(
				`/zones/${encodeURIComponent(options.zoneId)}/load_balancers/${encodeURIComponent(current.externalId)}`,
				{ method: "DELETE" },
			);
			if (!response.ok || !cloudflareSuccess(response.body)) {
				return parseRevokeResult(
					cloneAsJson({
						ok: false,
						notes: [providerFailure("revoke", response.status)],
					}),
				);
			}
			const accountId = options.accountId?.trim();
			if (
				options.deleteCreatedPoolsOnRevoke === true &&
				accountId &&
				current.createdPoolIds.length > 0
			) {
				for (const poolId of current.createdPoolIds) {
					await request(
						`/accounts/${encodeURIComponent(accountId)}/load_balancers/pools/${encodeURIComponent(poolId)}`,
						{ method: "DELETE" },
					);
				}
			}
			current.revoked = true;
			return parseRevokeResult(cloneAsJson({ ok: true, notes: [] }));
		},
	};
}

function supportedRule(plan: RoutingPlan, healthChecksConfigured: boolean) {
	const supported = plan.intent.rules.filter(
		(rule) => !hasEffectiveMatch(rule),
	);
	const unmet: string[] = [];
	for (const [index, rule] of plan.intent.rules.entries()) {
		if (rule.match?.pathPrefix) unmet.push(`rules[${index}].path-prefix`);
		if (rule.match?.headers) unmet.push(`rules[${index}].header-match`);
		if (rule.weightStrategy === "locality") {
			unmet.push("weightStrategy:locality");
		}
		if (rule.weightStrategy === "prefer-healthy" && !healthChecksConfigured) {
			unmet.push("health-monitoring");
		}
	}
	if (supported.length > 1) unmet.push("multiple-rules");
	if (plan.intent.availability) unmet.push("availability-constraints");
	if (plan.intent.resiliency) unmet.push("resiliency");
	return { rule: supported[0] ?? null, unmet: [...new Set(unmet)] };
}

function capabilitiesFor(
	rule: RoutingRule,
	healthChecksConfigured: boolean,
): TrafficRoutingCapability[] {
	return rule.weightStrategy === "prefer-healthy" && healthChecksConfigured
		? ["weighted-backends", "health-aware"]
		: ["weighted-backends"];
}

function cloudflareLoadBalancer(
	plan: RoutingPlan,
	rule: RoutingRule,
	poolIds: readonly string[],
) {
	const weights = normalizedWeights(rule);
	const poolWeights = Object.fromEntries(
		poolIds.map((poolId, index) => [poolId, weights[index]]),
	);
	return {
		name: plan.intent.service,
		default_pools: poolIds,
		fallback_pool: poolIds[0],
		steering_policy: "random",
		enabled: true,
		random_steering: { pool_weights: poolWeights },
	};
}

async function resolveOrCreatePools(
	rule: RoutingRule,
	options: CloudflareTrafficRoutingOptions,
	request: (
		path: string,
		init?: RequestInit,
	) => Promise<{ ok: boolean; status: number; body: JsonValue }>,
): Promise<
	| {
			readonly ok: true;
			readonly poolIds: string[];
			readonly createdPoolIds: string[];
	  }
	| { readonly ok: false; readonly unmet: string[]; readonly notes: string[] }
> {
	const poolIds: string[] = [];
	const createdPoolIds: string[] = [];
	const accountId = options.accountId?.trim();
	for (const backend of rule.backends) {
		const mapped = options.poolIdsByBackend?.[backend.id]?.trim();
		if (mapped) {
			poolIds.push(mapped);
			continue;
		}
		if (!backend.endpoint) {
			return {
				ok: false,
				unmet: [`pool:${backend.id}`, `endpoint:${backend.id}`],
				notes: [
					"Cloudflare pool create requires a backend endpoint when no pool mapping is provided",
				],
			};
		}
		if (!accountId) {
			return {
				ok: false,
				unmet: [`pool:${backend.id}`, "accountId"],
				notes: [
					"Cloudflare accountId is required to create pools (or supply poolIdsByBackend)",
				],
			};
		}
		const origin = poolOrigin(backend.endpoint);
		if (!origin) {
			return {
				ok: false,
				unmet: [`endpoint:${backend.id}`],
				notes: ["backend endpoint must be an absolute HTTP(S) URL with host"],
			};
		}
		const create = await request(
			`/accounts/${encodeURIComponent(accountId)}/load_balancers/pools`,
			{
				method: "POST",
				body: JSON.stringify({
					name: `hobo-${sanitizeName(backend.id)}`,
					origins: [
						{
							name: sanitizeName(backend.id),
							address: origin.address,
							enabled: true,
							weight: backend.weight ?? 1,
						},
					],
					enabled: true,
					minimum_origins: 1,
				}),
			},
		);
		const poolId = cloudflareResultId(create.body);
		if (!create.ok || !cloudflareSuccess(create.body) || !poolId) {
			return {
				ok: false,
				unmet: ["provider-api", `pool-create:${backend.id}`],
				notes: [providerFailure("pool-create", create.status)],
			};
		}
		poolIds.push(poolId);
		createdPoolIds.push(poolId);
	}
	const duplicates = poolIds
		.filter((poolId, index) => poolIds.indexOf(poolId) !== index)
		.map((poolId) => `duplicate-pool:${poolId}`);
	if (duplicates.length > 0) {
		return {
			ok: false,
			unmet: [...new Set(duplicates)],
			notes: ["Cloudflare pool ids must be unique across backends"],
		};
	}
	return { ok: true, poolIds, createdPoolIds };
}

function poolOrigin(endpoint: string): { readonly address: string } | null {
	try {
		const url = new URL(endpoint);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return { address: url.hostname };
	} catch {
		return null;
	}
}

function cloudflareResultId(body: JsonValue): string | undefined {
	if (!isJsonObject(body) || body.success !== true) return undefined;
	const result = body.result;
	if (!result || !isJsonObject(result)) return undefined;
	// SAFETY: assertion required at this I/O or test boundary.
	const id = (result as { id?: unknown }).id;
	return isJsonString(id) && id.trim().length > 0 ? id.trim() : undefined;
}

function cloudflarePoolHealthy(body: JsonValue): boolean | undefined {
	if (!isJsonObject(body) || body.success !== true) return undefined;
	const result = body.result;
	if (!result || !isJsonObject(result)) return undefined;
	// SAFETY: assertion required at this I/O or test boundary.
	const pool = result as {
		healthy?: unknown;
		pop_health?: unknown;
	};
	if (isJsonBoolean(pool.healthy)) return pool.healthy;
	// Some CF responses nest health under pop_health.*.healthy
	if (pool.pop_health && isJsonObject(pool.pop_health)) {
		// SAFETY: assertion required at this I/O or test boundary.
		const values = Object.values(pool.pop_health as JsonObject);
		const flags = values
			.map((entry) =>
				isJsonObject(entry) && isJsonBoolean(entry.healthy)
					? entry.healthy
					: undefined,
			)
			.filter((flag): flag is boolean => isJsonBoolean(flag));
		if (flags.length === 0) return undefined;
		return flags.every(Boolean);
	}
	return undefined;
}

function sanitizeName(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/gu, "-").slice(0, 64);
}

function normalizedWeights(rule: RoutingRule): number[] {
	const weights = rule.backends.map(({ weight }) => weight ?? 1);
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	if (total === 0) return weights.map(() => 1 / weights.length);
	return weights.map((weight) => weight / total);
}

function hasEffectiveMatch(rule: RoutingRule): boolean {
	return Boolean(
		rule.match?.pathPrefix ||
			(rule.match?.headers && Object.keys(rule.match.headers).length > 0),
	);
}

function resultFor(
	plan: RoutingPlan,
	realized: "full" | "partial" | "none",
	appliedRules: number,
	unmet: readonly string[],
	notes: readonly string[],
	capabilities: readonly TrafficRoutingCapability[] = [],
) {
	return parseApplyResult(
		cloneAsJson({
			planId: plan.planId,
			provider: "cloudflare",
			realized,
			notes,
			appliedRules,
			...(unmet.length === 0 ? undefined : { unmet: [...new Set(unmet)] }),
			capabilities,
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
				provider: "cloudflare",
				outcome,
			}),
		);
	} catch {
		// Provider realization remains authoritative when observation delivery fails.
	}
}

function cloudflareEnabled(body: JsonValue): boolean {
	if (!isJsonObject(body) || body.success !== true) return false;
	const result = body.result;
	return isJsonObject(result) && result.enabled === true;
}

function cloudflareSuccess(body: JsonValue): boolean {
	return isJsonObject(body) && body.success === true;
}

function cloudflareObservedMatches(
	body: JsonValue,
	expected: ReturnType<typeof cloudflareLoadBalancer>,
): boolean {
	if (!isJsonObject(body) || body.success !== true) return false;
	const result = body.result;
	if (!isJsonObject(result)) return false;
	const randomSteering = result.random_steering;
	if (!isJsonObject(randomSteering)) return false;
	return (
		result.name === expected.name &&
		result.steering_policy === expected.steering_policy &&
		sameStringArray(result.default_pools, expected.default_pools) &&
		result.fallback_pool === expected.fallback_pool &&
		sameNumberRecord(
			randomSteering.pool_weights,
			expected.random_steering.pool_weights,
		)
	);
}

function sameStringArray(
	value: JsonValue | undefined,
	expected: readonly string[],
): boolean {
	return (
		Array.isArray(value) &&
		value.length === expected.length &&
		value.every((entry, index) => entry === expected[index])
	);
}

function sameNumberRecord(
	value: JsonValue | undefined,
	expected: Readonly<Record<string, number | undefined>>,
): boolean {
	if (!value || !isJsonObject(value)) return false;
	// SAFETY: assertion required at this I/O or test boundary.
	const observed = value as JsonObject;
	const expectedKeys = Object.keys(expected);
	return (
		Object.keys(observed).length === expectedKeys.length &&
		expectedKeys.every((key) => observed[key] === expected[key])
	);
}

function isDnsHostname(value: string): boolean {
	return (
		value.length <= 253 &&
		value.includes(".") &&
		value
			.split(".")
			.every(
				(label) =>
					label.length > 0 &&
					label.length <= 63 &&
					/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label),
			)
	);
}

function providerFailure(operation: string, status: number): string {
	return status === 0
		? `Cloudflare ${operation} request failed`
		: `Cloudflare ${operation} failed (HTTP ${status})`;
}

function headersObject(
	headers: HeadersInit | undefined,
): Record<string, string> {
	if (!headers) return {};
	return Object.fromEntries(new Headers(headers).entries());
}
