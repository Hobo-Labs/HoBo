import {
	type ApplyResult,
	createTrafficRoutingMeteringEvent,
	type MeteringBus,
	parseApplyResult,
	parseRevokeResult,
	parseRoutingStatus,
	type RoutingPlan,
	type RoutingPlanId,
	type TrafficRoutingCapability,
	type TrafficRoutingPort,
} from "@hobo/core";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../json.js";

export type VercelTrafficMode = "rolling-release" | "rewrites" | "auto";

export interface VercelTrafficRouting extends TrafficRoutingPort {
	readonly provider: "vercel";
	readonly revoke: NonNullable<TrafficRoutingPort["revoke"]>;
}

export interface VercelTrafficRoutingOptions {
	/** Vercel bearer token. Never logged or metered. */
	readonly token?: string;
	/** Project id or name used for Rolling Releases and project routes. */
	readonly projectIdOrName: string;
	readonly teamId?: string;
	readonly apiBase?: string;
	readonly fetchImpl?: typeof fetch;
	readonly metering?: MeteringBus;
	/**
	 * Map HoBo backend ids → Vercel deployment ids for Rolling Release canary.
	 * Exactly two backends are required for full RR realization.
	 */
	readonly deploymentIdsByBackend?: Readonly<Record<string, string>>;
	/** Force a realization mode; default auto-detects from the plan shape. */
	readonly mode?: VercelTrafficMode;
}

interface AppliedPlan {
	readonly mode: "rolling-release" | "rewrites";
	readonly plan: RoutingPlan;
	readonly fingerprint: string;
	readonly result: ApplyResult;
	readonly expected: unknown;
	readonly routeVersionId?: string;
	revoked: boolean;
}

/**
 * Production Vercel TrafficRouting adapter.
 *
 * - Rolling Releases: weighted canary between two mapped deployments.
 * - Project routes: path-prefix (and optional header) external rewrites,
 *   staged then promoted to production.
 */
export function createVercelTrafficRouting(
	options: VercelTrafficRoutingOptions,
): VercelTrafficRouting {
	const token = options.token?.trim();
	const project = options.projectIdOrName.trim();
	const base = (options.apiBase ?? "https://api.vercel.com").replace(
		/\/+$/u,
		"",
	);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const applied = new Map<RoutingPlanId, AppliedPlan>();

	async function request(path: string, init?: RequestInit) {
		if (!token || !fetchImpl) return { ok: false, status: 0, body: null };
		const url = new URL(`${base}${path}`);
		if (options.teamId?.trim())
			url.searchParams.set("teamId", options.teamId.trim());
		try {
			const response = await fetchImpl(url.toString(), {
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
		provider: "vercel",
		async apply(plan) {
			if (!token) {
				const result = deny(
					plan,
					["credentials"],
					["Vercel API token is required"],
				);
				await meter(options.metering, plan, "deny");
				return result;
			}
			if (!project) {
				const result = deny(
					plan,
					["project"],
					["Vercel project id or name is required"],
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
				const result = deny(
					plan,
					["plan-id-conflict"],
					["planId is already active with different routing content"],
				);
				await meter(options.metering, plan, "deny");
				return result;
			}

			const mode = resolveMode(plan, options.mode);
			if (mode === "rolling-release") {
				return applyRollingRelease(
					plan,
					fingerprint,
					request,
					options,
					applied,
				);
			}
			if (mode === "rewrites") {
				return applyRewrites(plan, fingerprint, request, options, applied);
			}
			const result = deny(
				plan,
				["mode"],
				["plan shape is not a Vercel rolling-release or rewrites realization"],
			);
			await meter(options.metering, plan, "deny");
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
			if (current.mode === "rolling-release") {
				const response = await request(
					`/v1/projects/${encodeURIComponent(project)}/rolling-release`,
				);
				if (!response.ok) {
					return parseRoutingStatus(
						cloneAsJson({
							planId,
							active: false,
							realized: "partial",
							notes: [providerFailure("status", response.status)],
						}),
					);
				}
				const state = rollingReleaseState(response.body);
				const active = state === "ACTIVE" || state === "COMPLETE";
				return parseRoutingStatus(
					cloneAsJson({
						planId,
						active,
						realized: !active
							? "none"
							: state === "COMPLETE"
								? current.result.realized
								: "partial",
						notes:
							state === "ACTIVE"
								? ["Vercel rolling release is active"]
								: state === "COMPLETE"
									? current.result.notes
									: ["Vercel rolling release is not active"],
					}),
				);
			}

			const response = await request(
				`/v1/projects/${encodeURIComponent(project)}/routes`,
			);
			if (!response.ok) {
				return parseRoutingStatus(
					cloneAsJson({
						planId,
						active: false,
						realized: "partial",
						notes: [providerFailure("status", response.status)],
					}),
				);
			}
			const routes = projectRoutes(response.body);
			// SAFETY: assertion required at this I/O or test boundary.
			const expected = current.expected as {
				readonly routes: readonly { readonly id: string }[];
			};
			const ids = new Set(expected.routes.map((route) => route.id));
			const live = routes.filter(
				(route) => ids.has(route.id) && route.enabled !== false,
			);
			const active = live.length === expected.routes.length;
			return parseRoutingStatus(
				cloneAsJson({
					planId,
					active,
					realized: active ? current.result.realized : "partial",
					notes: active
						? current.result.notes
						: ["Vercel project routes do not match the applied plan"],
				}),
			);
		},
		async revoke(planId) {
			if (!token) {
				return parseRevokeResult(
					cloneAsJson({
						ok: false,
						notes: ["Vercel API token is required"],
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

			if (current.mode === "rolling-release") {
				const response = await request(
					`/v1/projects/${encodeURIComponent(project)}/rolling-release/config`,
					{ method: "DELETE" },
				);
				if (!response.ok) {
					return parseRevokeResult(
						cloneAsJson({
							ok: false,
							notes: [providerFailure("revoke", response.status)],
						}),
					);
				}
				current.revoked = true;
				return parseRevokeResult(cloneAsJson({ ok: true, notes: [] }));
			}

			const response = await request(
				`/v1/projects/${encodeURIComponent(project)}/routes`,
				{
					method: "PUT",
					body: JSON.stringify({ overwrite: true, routes: [] }),
				},
			);
			if (!response.ok) {
				return parseRevokeResult(
					cloneAsJson({
						ok: false,
						notes: [providerFailure("revoke", response.status)],
					}),
				);
			}
			const versionId = routeVersionId(response.body) ?? current.routeVersionId;
			if (versionId) {
				const promote = await request(
					`/v1/projects/${encodeURIComponent(project)}/routes/versions`,
					{
						method: "POST",
						body: JSON.stringify({ id: versionId, action: "promote" }),
					},
				);
				if (!promote.ok) {
					return parseRevokeResult(
						cloneAsJson({
							ok: false,
							notes: [providerFailure("revoke-promote", promote.status)],
						}),
					);
				}
			}
			current.revoked = true;
			return parseRevokeResult(cloneAsJson({ ok: true, notes: [] }));
		},
	};
}

async function applyRollingRelease(
	plan: RoutingPlan,
	fingerprint: string,
	request: (
		path: string,
		init?: RequestInit,
	) => Promise<{ ok: boolean; status: number; body: JsonValue }>,
	options: VercelTrafficRoutingOptions,
	applied: Map<RoutingPlanId, AppliedPlan>,
): Promise<ApplyResult> {
	const project = options.projectIdOrName.trim();
	const { rule, unmet, canaryBackend, stableBackend } =
		rollingReleaseSupport(plan);
	if (!rule || !canaryBackend || !stableBackend) {
		const result = deny(plan, unmet, [
			"Vercel rolling release requires exactly two static weighted backends",
		]);
		await meter(options.metering, plan, "deny");
		return result;
	}
	const canaryDeployment =
		options.deploymentIdsByBackend?.[canaryBackend.id]?.trim();
	const stableDeployment =
		options.deploymentIdsByBackend?.[stableBackend.id]?.trim();
	if (!canaryDeployment || !stableDeployment) {
		const missing = [
			...(canaryDeployment ? [] : [`deployment:${canaryBackend.id}`]),
			...(stableDeployment ? [] : [`deployment:${stableBackend.id}`]),
		];
		const result = deny(
			plan,
			[...unmet, ...missing],
			[
				"Vercel deployment mappings are required for every rolling-release backend",
			],
		);
		await meter(options.metering, plan, "deny");
		return result;
	}

	const canaryPercent = weightPercent(
		canaryBackend.weight,
		stableBackend.weight,
	);
	const configBody = {
		target: "production",
		stages: [
			{ targetPercentage: canaryPercent, requireApproval: false },
			{ targetPercentage: 100, requireApproval: false },
		],
	};
	const config = await request(
		`/v1/projects/${encodeURIComponent(project)}/rolling-release/config`,
		{ method: "PATCH", body: JSON.stringify(configBody) },
	);
	if (!config.ok) {
		const result = deny(
			plan,
			["provider-api"],
			[providerFailure("apply-config", config.status)],
		);
		await meter(options.metering, plan, "deny");
		return result;
	}
	const start = await request(
		`/v1/projects/${encodeURIComponent(project)}/rolling-release/start`,
		{
			method: "POST",
			body: JSON.stringify({ canaryDeploymentId: canaryDeployment }),
		},
	);
	if (!start.ok) {
		const result = deny(
			plan,
			["provider-api"],
			[providerFailure("apply-start", start.status)],
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
			? []
			: ["Vercel applied the provider-safe rolling-release subset"],
		["weighted-backends"],
	);
	applied.set(plan.planId, {
		mode: "rolling-release",
		plan,
		fingerprint,
		result,
		expected: { canaryDeployment, stableDeployment, configBody },
		revoked: false,
	});
	await meter(
		options.metering,
		plan,
		realized === "full" ? "apply" : "degraded",
	);
	return result;
}

async function applyRewrites(
	plan: RoutingPlan,
	fingerprint: string,
	request: (
		path: string,
		init?: RequestInit,
	) => Promise<{ ok: boolean; status: number; body: JsonValue }>,
	options: VercelTrafficRoutingOptions,
	applied: Map<RoutingPlanId, AppliedPlan>,
): Promise<ApplyResult> {
	const project = options.projectIdOrName.trim();
	const { routes, unmet, appliedRules, capabilities } = rewriteRoutes(plan);
	if (routes.length === 0) {
		const result = deny(plan, unmet, [
			"Vercel rewrites require path-prefix rules with backend endpoints",
		]);
		await meter(options.metering, plan, "deny");
		return result;
	}

	const stageBody = { overwrite: true, routes };
	const stage = await request(
		`/v1/projects/${encodeURIComponent(project)}/routes`,
		{ method: "PUT", body: JSON.stringify(stageBody) },
	);
	if (!stage.ok) {
		const result = deny(
			plan,
			["provider-api"],
			[providerFailure("apply-stage", stage.status)],
		);
		await meter(options.metering, plan, "deny");
		return result;
	}
	const versionId = routeVersionId(stage.body);
	if (!versionId) {
		const result = deny(
			plan,
			["provider-api"],
			["Vercel route stage did not return a version id"],
		);
		await meter(options.metering, plan, "deny");
		return result;
	}
	const promote = await request(
		`/v1/projects/${encodeURIComponent(project)}/routes/versions`,
		{
			method: "POST",
			body: JSON.stringify({ id: versionId, action: "promote" }),
		},
	);
	if (!promote.ok) {
		const result = deny(
			plan,
			["provider-api"],
			[providerFailure("apply-promote", promote.status)],
		);
		await meter(options.metering, plan, "deny");
		return result;
	}

	const realized = unmet.length === 0 ? "full" : "partial";
	const result = resultFor(
		plan,
		realized,
		appliedRules,
		unmet,
		realized === "full"
			? []
			: ["Vercel applied the provider-safe project-routes subset"],
		capabilities,
	);
	applied.set(plan.planId, {
		mode: "rewrites",
		plan,
		fingerprint,
		result,
		expected: stageBody,
		routeVersionId: versionId,
		revoked: false,
	});
	await meter(
		options.metering,
		plan,
		realized === "full" ? "apply" : "degraded",
	);
	return result;
}

function resolveMode(
	plan: RoutingPlan,
	forced: VercelTrafficMode | undefined,
): "rolling-release" | "rewrites" | null {
	if (forced === "rolling-release" || forced === "rewrites") return forced;
	const { rule, canaryBackend, stableBackend } = rollingReleaseSupport(plan);
	if (rule && canaryBackend && stableBackend) return "rolling-release";
	const { routes } = rewriteRoutes(plan);
	if (routes.length > 0) return "rewrites";
	return null;
}

function rollingReleaseSupport(plan: RoutingPlan) {
	const unmet: string[] = [];
	if (plan.intent.rules.length !== 1) unmet.push("multiple-rules");
	const rule = plan.intent.rules[0] ?? null;
	if (!rule) {
		return { rule: null, unmet, canaryBackend: null, stableBackend: null };
	}
	if (rule.weightStrategy !== "static")
		unmet.push(`weightStrategy:${rule.weightStrategy}`);
	if (rule.match?.pathPrefix) unmet.push("rules[0].path-prefix");
	if (rule.match?.headers) unmet.push("rules[0].header-match");
	if (rule.backends.length !== 2) unmet.push("backend-count");
	if (plan.intent.availability) unmet.push("availability-constraints");
	if (plan.intent.resiliency) unmet.push("resiliency");
	if (unmet.length > 0 || rule.backends.length !== 2) {
		return { rule: null, unmet, canaryBackend: null, stableBackend: null };
	}
	// Higher weight is treated as stable; lower (or equal second) is canary.
	const sorted = [...rule.backends].sort(
		(left, right) => (right.weight ?? 1) - (left.weight ?? 1),
	);
	return {
		rule,
		unmet,
		stableBackend: sorted[0] ?? null,
		canaryBackend: sorted[1] ?? null,
	};
}

function rewriteRoutes(plan: RoutingPlan) {
	const unmet: string[] = [];
	const routes: Array<{
		readonly id: string;
		readonly name: string;
		readonly enabled: boolean;
		readonly route: {
			readonly src: string;
			readonly dest: string;
			readonly has?: readonly {
				readonly type: "header";
				readonly key: string;
				readonly value: string;
			}[];
		};
	}> = [];
	let appliedRules = 0;
	let pathCapability = false;
	let headerCapability = false;

	if (plan.intent.availability) unmet.push("availability-constraints");
	if (plan.intent.resiliency) unmet.push("resiliency");

	for (const [index, rule] of plan.intent.rules.entries()) {
		if (rule.weightStrategy !== "static") {
			unmet.push(`rules[${index}].weightStrategy:${rule.weightStrategy}`);
			continue;
		}
		if (!rule.match?.pathPrefix) {
			unmet.push(`rules[${index}].path-prefix`);
			continue;
		}
		if (rule.backends.length !== 1) {
			unmet.push(`rules[${index}].backend-count`);
			continue;
		}
		const backend = rule.backends[0];
		if (!backend?.endpoint) {
			unmet.push(`rules[${index}].endpoint`);
			continue;
		}
		const src = pathToSrc(rule.match.pathPrefix);
		const dest = joinDest(backend.endpoint, rule.match.pathPrefix);
		const has = rule.match.headers
			? Object.entries(rule.match.headers).map(([key, value]) => ({
					type: "header" as const,
					key,
					value,
				}))
			: undefined;
		routes.push({
			id: `hobo-${sanitizeId(plan.planId)}-${index}`,
			name: `hobo:${plan.planId}:${index}`,
			enabled: true,
			route: {
				src,
				dest,
				...(has && has.length > 0 ? { has } : undefined),
			},
		});
		appliedRules += 1;
		pathCapability = true;
		if (has && has.length > 0) headerCapability = true;
	}

	const capabilities: TrafficRoutingCapability[] = [];
	if (pathCapability) capabilities.push("path-prefix");
	if (headerCapability) capabilities.push("header-match");
	if (routes.length > 0) capabilities.push("weighted-backends");

	return { routes, unmet: [...new Set(unmet)], appliedRules, capabilities };
}

function weightPercent(
	canaryWeight: number | undefined,
	stableWeight: number | undefined,
): number {
	const canary = canaryWeight ?? 1;
	const stable = stableWeight ?? 1;
	const total = canary + stable;
	if (total <= 0) return 50;
	return Math.max(1, Math.min(99, Math.round((canary / total) * 100)));
}

function pathToSrc(pathPrefix: string): string {
	const base = pathPrefix.endsWith("/") ? pathPrefix.slice(0, -1) : pathPrefix;
	return `${base}/:path*`;
}

function joinDest(endpoint: string, _pathPrefix: string): string {
	const url = new URL(endpoint);
	const basePath = url.pathname.replace(/\/+$/u, "");
	return `${url.origin}${basePath}/:path*`;
}

function sanitizeId(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/gu, "-").slice(0, 80);
}

function rollingReleaseState(body: JsonValue): string | null {
	if (!body || !isJsonObject(body)) return null;
	// SAFETY: assertion required at this I/O or test boundary.
	const rolling = (body as { rollingRelease?: { state?: unknown } })
		.rollingRelease;
	return isJsonString(rolling?.state) ? rolling.state : null;
}

function projectRoutes(
	body: JsonValue,
): readonly { readonly id: string; readonly enabled?: boolean }[] {
	if (!body || !isJsonObject(body)) return [];
	// SAFETY: assertion required at this I/O or test boundary.
	const routes = (body as { routes?: unknown }).routes;
	if (!Array.isArray(routes)) return [];
	return routes
		.filter(
			(route): route is { id: string; enabled?: boolean } =>
				Boolean(route) &&
				isJsonObject(route) &&
				// SAFETY: assertion required at this I/O or test boundary.
				isJsonString(route.id),
		)
		.map((route) =>
			route.enabled === undefined
				? { id: route.id }
				: { id: route.id, enabled: route.enabled },
		);
}

function routeVersionId(body: JsonValue): string | undefined {
	if (!body || !isJsonObject(body)) return undefined;
	// SAFETY: assertion required at this I/O or test boundary.
	const version = (body as { version?: { id?: unknown } }).version;
	return isJsonString(version?.id) ? version.id : undefined;
}

function deny(
	plan: RoutingPlan,
	unmet: readonly string[],
	notes: readonly string[],
) {
	return resultFor(plan, "none", 0, unmet, notes, []);
}

function resultFor(
	plan: RoutingPlan,
	realized: "full" | "partial" | "none",
	appliedRules: number,
	unmet: readonly string[],
	notes: readonly string[],
	capabilities: readonly TrafficRoutingCapability[],
) {
	return parseApplyResult(
		cloneAsJson({
			planId: plan.planId,
			provider: "vercel",
			realized,
			notes,
			appliedRules,
			...(unmet.length === 0 ? undefined : { unmet: [...new Set(unmet)] }),
			capabilities,
		}),
	);
}

function providerFailure(op: string, status: number): string {
	return `vercel ${op} failed${status > 0 ? ` (HTTP ${status})` : ""}`;
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
				provider: "vercel",
				outcome,
			}),
		);
	} catch {
		// Provider realization remains authoritative when observation delivery fails.
	}
}

function headersObject(headers: HeadersInit | undefined) {
	if (!headers) return {};
	if (headers instanceof Headers) {
		return Object.fromEntries(headers.entries());
	}
	if (Array.isArray(headers)) {
		return Object.fromEntries(headers);
	}
	return { ...headers };
}
