import { createMeteringBus, parseRoutingPlan } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { isJsonString } from "../../src/json.js";

import { createInMemoryMeteringSink } from "../../src/metering/sinks.js";
import { createCloudflareTrafficRouting } from "../../src/traffic-routing/cloudflare.js";
import { createSimpleTrafficRouting } from "../../src/traffic-routing/simple.js";

function plan(
	weightStrategy: "static" | "prefer-healthy" | "locality" = "static",
	match?: {
		readonly pathPrefix?: string;
		readonly headers?: Readonly<Record<string, string>>;
	},
) {
	const backends = [
		{
			id: "backend:primary",
			service: "checkout-primary",
			weight: 80,
			endpoint: "https://primary.example.test",
		},
		{
			id: "backend:canary",
			service: "checkout-canary",
			weight: 20,
			endpoint: "https://canary.example.test",
		},
	];
	return parseRoutingPlan({
		planId: "plan:checkout",
		intent: {
			service: "checkout.example.test",
			tenantId: "tenant-a",
			rules: [
				{
					...(match ? { match } : undefined),
					backends,
					weightStrategy,
				},
			],
		},
		backends,
		createdAt: "2026-08-03T15:00:00.000Z",
	});
}

describe("simple traffic routing", () => {
	it("applies static weights deterministically and supports status and revoke", async () => {
		const sink = createInMemoryMeteringSink();
		const routing = createSimpleTrafficRouting({
			metering: createMeteringBus([sink]),
		});
		const routingPlan = plan();

		await expect(routing.apply(routingPlan)).resolves.toMatchObject({
			planId: routingPlan.planId,
			provider: "simple",
			realized: "full",
			appliedRules: 1,
		});
		const first = routing.select(routingPlan.planId, "request-42");
		expect(first).not.toBeNull();
		expect(routing.select(routingPlan.planId, "request-42")?.id).toBe(
			first?.id,
		);
		expect(
			new Set(
				Array.from(
					{ length: 100 },
					(_, index) =>
						routing.select(routingPlan.planId, `request-${index}`)?.id,
				),
			),
		).toEqual(new Set(["backend:primary", "backend:canary"]));
		await expect(routing.status(routingPlan.planId)).resolves.toMatchObject({
			active: true,
			realized: "full",
		});
		expect(sink.events.map(({ eventType }) => eventType)).toEqual([
			"routing.plan.apply",
		]);

		await expect(routing.revoke(routingPlan.planId)).resolves.toEqual({
			ok: true,
			notes: [],
		});
		expect(routing.select(routingPlan.planId, "request-42")).toBeNull();
		await expect(routing.status(routingPlan.planId)).resolves.toMatchObject({
			active: false,
			realized: "none",
		});
	});

	it("degrades unsupported dynamic strategies to declared backend order", async () => {
		const routing = createSimpleTrafficRouting();
		const routingPlan = plan("prefer-healthy");

		await expect(routing.apply(routingPlan)).resolves.toMatchObject({
			realized: "partial",
			unmet: ["weightStrategy:prefer-healthy"],
		});
		expect(routing.select(routingPlan.planId, "any-key")?.id).toBe(
			"backend:primary",
		);
	});

	it("reports match rules as partial instead of claiming to evaluate them", async () => {
		const routing = createSimpleTrafficRouting();
		await expect(
			routing.apply(plan("static", { pathPrefix: "/api" })),
		).resolves.toMatchObject({
			realized: "partial",
			unmet: ["rules[0].path-prefix"],
		});
	});

	it("gives unweighted backends equal deterministic participation", async () => {
		const backends = [
			{ id: "backend:a", service: "checkout-a" },
			{ id: "backend:b", service: "checkout-b" },
		];
		const routingPlan = parseRoutingPlan({
			planId: "plan:unweighted",
			intent: {
				service: "checkout",
				tenantId: "tenant-a",
				rules: [{ backends }],
			},
			backends,
			createdAt: "2026-08-03T15:00:00.000Z",
		});
		const routing = createSimpleTrafficRouting();
		await routing.apply(routingPlan);

		expect(
			new Set(
				Array.from(
					{ length: 20 },
					(_, index) => routing.select(routingPlan.planId, `key-${index}`)?.id,
				),
			),
		).toEqual(new Set(["backend:a", "backend:b"]));
	});

	it("reports multi-rule selection as partial", async () => {
		const backends = [{ id: "backend:a", service: "checkout-a" }];
		const routingPlan = parseRoutingPlan({
			planId: "plan:multiple-rules",
			intent: {
				service: "checkout",
				tenantId: "tenant-a",
				rules: [{ backends }, { backends }],
			},
			backends,
			createdAt: "2026-08-03T15:00:00.000Z",
		});

		await expect(
			createSimpleTrafficRouting().apply(routingPlan),
		).resolves.toMatchObject({
			realized: "partial",
			appliedRules: 0,
			unmet: ["multiple-rules"],
		});
	});

	it("keeps applied state when metering delivery fails", async () => {
		const routing = createSimpleTrafficRouting({
			metering: {
				emit() {
					throw new Error("meter unavailable");
				},
			},
		});
		const routingPlan = plan();

		await expect(routing.apply(routingPlan)).resolves.toMatchObject({
			realized: "full",
		});
		await expect(routing.status(routingPlan.planId)).resolves.toMatchObject({
			active: true,
		});
	});
});

describe("Cloudflare traffic routing", () => {
	it("denies apply without credentials and never calls the provider", async () => {
		const sink = createInMemoryMeteringSink();
		let fetches = 0;
		const routing = createCloudflareTrafficRouting({
			zoneId: "zone-a",
			metering: createMeteringBus([sink]),
			fetchImpl: async () => {
				fetches += 1;
				throw new Error("must not fetch");
			},
		});

		const result = await routing.apply(plan());
		expect(result).toMatchObject({
			provider: "cloudflare",
			realized: "none",
			appliedRules: 0,
		});
		expect(result.unmet).toContain("credentials");
		expect(fetches).toBe(0);
		expect(sink.events.map(({ eventType }) => eventType)).toEqual([
			"routing.plan.deny",
		]);
	});

	it("applies, observes, and revokes one provider route without leaking credentials", async () => {
		const token = "cf-secret-token";
		const sink = createInMemoryMeteringSink();
		const requests: {
			url: string;
			method: string;
			headers: Headers;
			body?: string;
		}[] = [];
		const routing = createCloudflareTrafficRouting({
			apiToken: token,
			zoneId: "zone-a",
			loadBalancerIdsByPlan: { "plan:checkout": "load-balancer-a" },
			poolIdsByBackend: {
				"backend:primary": "pool-primary",
				"backend:canary": "pool-canary",
			},
			apiBase: "https://cloudflare.example.test/client/v4",
			metering: createMeteringBus([sink]),
			fetchImpl: async (input, init) => {
				requests.push({
					url: String(input),
					method: init?.method ?? "GET",
					headers: new Headers(init?.headers),
					...(isJsonString(init?.body) ? { body: init.body } : undefined),
				});
				if (init?.method === "DELETE") {
					return Response.json({ success: true });
				}
				return Response.json({
					success: true,
					result: {
						id: "load-balancer-a",
						enabled: true,
						name: "checkout.example.test",
						default_pools: ["pool-primary", "pool-canary"],
						fallback_pool: "pool-primary",
						steering_policy: "random",
						random_steering: {
							pool_weights: { "pool-canary": 0.2, "pool-primary": 0.8 },
						},
					},
				});
			},
		});
		const routingPlan = plan();

		const applied = await routing.apply(routingPlan);
		expect(applied).toMatchObject({
			provider: "cloudflare",
			realized: "full",
			appliedRules: 1,
			capabilities: ["weighted-backends"],
		});
		await expect(routing.status(routingPlan.planId)).resolves.toMatchObject({
			active: true,
			realized: "full",
		});
		await expect(routing.revoke(routingPlan.planId)).resolves.toEqual({
			ok: true,
			notes: [],
		});
		expect(requests.map(({ method }) => method)).toEqual([
			"PUT",
			"GET",
			"DELETE",
		]);
		expect(requests[0]?.url).toBe(
			"https://cloudflare.example.test/client/v4/zones/zone-a/load_balancers/load-balancer-a",
		);
		expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
		expect(requests[0]?.body).not.toContain(token);
		expect(JSON.parse(requests[0]?.body ?? "null")).toMatchObject({
			default_pools: ["pool-primary", "pool-canary"],
			fallback_pool: "pool-primary",
			steering_policy: "random",
			random_steering: {
				pool_weights: { "pool-primary": 0.8, "pool-canary": 0.2 },
			},
		});
		expect(JSON.stringify({ applied, events: sink.events })).not.toContain(
			token,
		);
	});

	it("observe.health reads pool health for applied pool map", async () => {
		const routing = createCloudflareTrafficRouting({
			apiToken: "cf-token",
			zoneId: "zone-a",
			accountId: "account-a",
			poolIdsByBackend: {
				"backend:primary": "pool-primary",
				"backend:canary": "pool-canary",
			},
			loadBalancerIdsByPlan: { "plan:checkout": "load-balancer-a" },
			apiBase: "https://cloudflare.example.test/client/v4",
			fetchImpl: async (input, init) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (url.includes("/health") && method === "GET") {
					const healthy = url.includes("pool-primary");
					return Response.json({
						success: true,
						result: { healthy },
					});
				}
				return Response.json({
					success: true,
					result: {
						id: "load-balancer-a",
						enabled: true,
						name: "checkout.example.test",
						default_pools: ["pool-primary", "pool-canary"],
						fallback_pool: "pool-primary",
						steering_policy: "random",
						random_steering: {
							pool_weights: { "pool-primary": 0.8, "pool-canary": 0.2 },
						},
					},
				});
			},
		});
		await routing.apply(plan());
		const observations = await routing.observeHealth("plan:checkout");
		expect(observations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					backendId: "backend:primary",
					healthy: true,
					poolId: "pool-primary",
				}),
				expect.objectContaining({
					backendId: "backend:canary",
					healthy: false,
					poolId: "pool-canary",
				}),
			]),
		);
	});

	it("creates pools and load balancer when mappings are absent (lifecycle)", async () => {
		const methods: string[] = [];
		const paths: string[] = [];
		const routing = createCloudflareTrafficRouting({
			apiToken: "cf-token",
			zoneId: "zone-a",
			accountId: "account-a",
			apiBase: "https://cloudflare.example.test/client/v4",
			fetchImpl: async (input, init) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				methods.push(method);
				paths.push(url);
				if (url.includes("/pools") && method === "POST") {
					// SAFETY: assertion required at this I/O or test boundary.
					const body = JSON.parse(String(init?.body ?? "{}")) as {
						name?: string;
					};
					const id = body.name?.includes("canary")
						? "pool-created-canary"
						: "pool-created-primary";
					// names are hobo-backend-primary / hobo-backend-canary
					return Response.json({ success: true, result: { id } });
				}
				if (url.endsWith("/load_balancers") && method === "POST") {
					return Response.json({
						success: true,
						result: {
							id: "lb-created",
							enabled: true,
							name: "checkout.example.test",
							default_pools: ["pool-created-primary", "pool-created-canary"],
							fallback_pool: "pool-created-primary",
							steering_policy: "random",
							random_steering: {
								pool_weights: {
									"pool-created-primary": 0.8,
									"pool-created-canary": 0.2,
								},
							},
						},
					});
				}
				if (method === "DELETE") {
					return Response.json({ success: true });
				}
				if (method === "GET") {
					return Response.json({
						success: true,
						result: {
							id: "lb-created",
							enabled: true,
							name: "checkout.example.test",
							default_pools: ["pool-created-primary", "pool-created-canary"],
							fallback_pool: "pool-created-primary",
							steering_policy: "random",
							random_steering: {
								pool_weights: {
									"pool-created-primary": 0.8,
									"pool-created-canary": 0.2,
								},
							},
						},
					});
				}
				return Response.json({ success: false }, { status: 500 });
			},
		});
		const routingPlan = plan();
		await expect(routing.apply(routingPlan)).resolves.toMatchObject({
			realized: "full",
			appliedRules: 1,
		});
		expect(methods.filter((method) => method === "POST")).toHaveLength(3);
		expect(paths.some((path) => path.includes("/accounts/account-a/"))).toBe(
			true,
		);
		await expect(routing.revoke(routingPlan.planId)).resolves.toEqual({
			ok: true,
			notes: [],
		});
	});

	it("does not claim health-aware routing without configured pool monitors", async () => {
		const routing = createCloudflareTrafficRouting({
			apiToken: "cf-token",
			zoneId: "zone-a",
			loadBalancerIdsByPlan: { "plan:checkout": "load-balancer-a" },
			poolIdsByBackend: {
				"backend:primary": "pool-primary",
				"backend:canary": "pool-canary",
			},
			fetchImpl: async () =>
				Response.json({ success: true, result: { id: "load-balancer-a" } }),
		});

		await expect(routing.apply(plan("prefer-healthy"))).resolves.toMatchObject({
			realized: "partial",
			unmet: ["health-monitoring"],
			capabilities: ["weighted-backends"],
		});
	});

	it("reports a provider-safe partial result for unsupported locality routing", async () => {
		const routing = createCloudflareTrafficRouting({
			apiToken: "cf-token",
			zoneId: "zone-a",
			loadBalancerIdsByPlan: { "plan:checkout": "load-balancer-a" },
			poolIdsByBackend: {
				"backend:primary": "pool-primary",
				"backend:canary": "pool-canary",
			},
			fetchImpl: async () =>
				Response.json({ success: true, result: { id: "load-balancer-a" } }),
		});

		await expect(routing.apply(plan("locality"))).resolves.toMatchObject({
			realized: "partial",
			appliedRules: 1,
			unmet: ["weightStrategy:locality"],
		});
	});

	it("refuses to post when a backend has no pool mapping and no accountId for create", async () => {
		let fetches = 0;
		const routing = createCloudflareTrafficRouting({
			apiToken: "cf-token",
			zoneId: "zone-a",
			poolIdsByBackend: { "backend:primary": "pool-primary" },
			fetchImpl: async () => {
				fetches += 1;
				return Response.json({ success: true });
			},
		});

		await expect(routing.apply(plan())).resolves.toMatchObject({
			realized: "none",
			appliedRules: 0,
			unmet: expect.arrayContaining(["pool:backend:canary", "accountId"]),
		});
		expect(fetches).toBe(0);
	});

	it("fails closed on a Cloudflare error envelope without echoing provider details", async () => {
		const token = "cf-secret-token";
		const routing = createCloudflareTrafficRouting({
			apiToken: token,
			zoneId: "zone-a",
			loadBalancerIdsByPlan: { "plan:checkout": "load-balancer-a" },
			poolIdsByBackend: {
				"backend:primary": "pool-primary",
				"backend:canary": "pool-canary",
			},
			fetchImpl: async () =>
				Response.json({
					success: false,
					result: { id: "must-not-accept" },
					errors: [{ message: `provider echoed ${token}` }],
				}),
		});

		const result = await routing.apply(plan());
		expect(result).toMatchObject({
			realized: "none",
			appliedRules: 0,
			unmet: ["provider-api"],
		});
		expect(JSON.stringify(result)).not.toContain(token);
	});

	it("reuses an active plan id and rejects duplicate pool mappings", async () => {
		let fetches = 0;
		const routing = createCloudflareTrafficRouting({
			apiToken: "cf-token",
			zoneId: "zone-a",
			loadBalancerIdsByPlan: { "plan:checkout": "load-balancer-a" },
			poolIdsByBackend: {
				"backend:primary": "pool-shared",
				"backend:canary": "pool-shared",
			},
			fetchImpl: async () => {
				fetches += 1;
				return Response.json({ success: true, result: { id: "lb-a" } });
			},
		});

		await expect(routing.apply(plan())).resolves.toMatchObject({
			realized: "none",
			unmet: ["duplicate-pool:pool-shared"],
		});
		expect(fetches).toBe(0);

		const idempotent = createCloudflareTrafficRouting({
			apiToken: "cf-token",
			zoneId: "zone-a",
			loadBalancerIdsByPlan: { "plan:checkout": "load-balancer-a" },
			poolIdsByBackend: {
				"backend:primary": "pool-primary",
				"backend:canary": "pool-canary",
			},
			fetchImpl: async () => {
				fetches += 1;
				return Response.json({ success: true, result: { id: "lb-a" } });
			},
		});
		const routingPlan = plan();
		await idempotent.apply(routingPlan);
		await idempotent.apply(routingPlan);
		expect(fetches).toBe(2);
	});

	it("does not turn a completed Cloudflare apply into failure when metering fails", async () => {
		let fetches = 0;
		const routing = createCloudflareTrafficRouting({
			apiToken: "cf-token",
			zoneId: "zone-a",
			loadBalancerIdsByPlan: { "plan:checkout": "load-balancer-a" },
			poolIdsByBackend: {
				"backend:primary": "pool-primary",
				"backend:canary": "pool-canary",
			},
			metering: {
				emit() {
					throw new Error("meter unavailable");
				},
			},
			fetchImpl: async () => {
				fetches += 1;
				return Response.json({ success: true, result: { id: "lb-a" } });
			},
		});
		const routingPlan = plan();

		await expect(routing.apply(routingPlan)).resolves.toMatchObject({
			realized: "full",
		});
		await routing.apply(routingPlan);
		expect(fetches).toBe(2);
	});

	it("degrades status when Cloudflare changes the steering policy", async () => {
		let method = "PUT";
		const routing = createCloudflareTrafficRouting({
			apiToken: "cf-token",
			zoneId: "zone-a",
			loadBalancerIdsByPlan: { "plan:checkout": "load-balancer-a" },
			poolIdsByBackend: {
				"backend:primary": "pool-primary",
				"backend:canary": "pool-canary",
			},
			fetchImpl: async (_input, init) => {
				method = init?.method ?? "GET";
				return Response.json({
					success: true,
					result:
						method === "PUT"
							? { id: "lb-a" }
							: {
									id: "lb-a",
									enabled: true,
									name: "checkout.example.test",
									default_pools: ["pool-primary", "pool-canary"],
									fallback_pool: "pool-primary",
									steering_policy: "dynamic_latency",
									random_steering: {
										pool_weights: {
											"pool-primary": 0.8,
											"pool-canary": 0.2,
										},
									},
								},
				});
			},
		});
		const routingPlan = plan();
		await routing.apply(routingPlan);

		await expect(routing.status(routingPlan.planId)).resolves.toMatchObject({
			active: true,
			realized: "partial",
		});
	});
});
