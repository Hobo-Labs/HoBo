import {
	createMeteringBus,
	type FunnelPublishOptions,
	type OverlayNetwork,
	parseRoutingPlan,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import { isJsonString } from "../../src/json.js";

import { createInMemoryMeteringSink } from "../../src/metering/sinks.js";
import { createFunnelTrafficRouting } from "../../src/traffic-routing/funnel.js";
import { createLakebedTrafficRouting } from "../../src/traffic-routing/lakebed.js";
import { createVercelTrafficRouting } from "../../src/traffic-routing/vercel.js";

function plan(backends = 1) {
	const entries = Array.from({ length: backends }, (_, index) => ({
		id: `backend:${index + 1}`,
		service: `checkout-${index + 1}`,
		weight: backends === 1 ? 100 : 50,
		endpoint: `http://127.0.0.1:${7_071 + index}`,
	}));
	return parseRoutingPlan({
		planId: `plan:funnel:${backends}`,
		intent: {
			service: "checkout",
			tenantId: "tenant-a",
			rules: [{ backends: entries }],
		},
		backends: entries,
		createdAt: "2026-08-03T15:00:00.000Z",
	});
}

function overlay(
	published: FunnelPublishOptions[],
	gatewayHostname: string | null = "checkout.example.ts.net",
	confirmed = true,
): OverlayNetwork {
	return {
		provider: "tailscale",
		async join() {
			throw new Error("not used");
		},
		async status() {
			return null;
		},
		async leave() {},
		tenantTags() {
			return [];
		},
		async publishFunnel(options) {
			published.push(options);
			return {
				enabled: true,
				confirmed,
				gatewayHostname,
				notes: [],
			};
		},
	};
}

describe("Funnel traffic routing", () => {
	it("publishes one simple endpoint and reports honest status/revoke support", async () => {
		const published: FunnelPublishOptions[] = [];
		const sink = createInMemoryMeteringSink();
		const routing = createFunnelTrafficRouting({
			overlay: overlay(published),
			metering: createMeteringBus([sink]),
		});
		const routingPlan = plan();

		await expect(routing.apply(routingPlan)).resolves.toMatchObject({
			provider: "funnel",
			realized: "full",
			appliedRules: 1,
		});
		expect(published).toEqual([
			expect.objectContaining({
				tenantId: "tenant-a",
				backendUrl: "http://127.0.0.1:7071",
				hostnameHint: "checkout",
			}),
		]);
		await expect(routing.status(routingPlan.planId)).resolves.toMatchObject({
			active: true,
			realized: "full",
		});
		await expect(routing.revoke(routingPlan.planId)).resolves.toEqual({
			ok: false,
			notes: ["overlay does not expose Funnel revoke"],
		});
		expect(sink.events.map(({ eventType }) => eventType)).toEqual([
			"routing.plan.apply",
		]);
	});

	it("realizes multi-backend weighted selection with a single public Funnel tip", async () => {
		const published: FunnelPublishOptions[] = [];
		const sink = createInMemoryMeteringSink();
		const routing = createFunnelTrafficRouting({
			overlay: overlay(published),
			metering: createMeteringBus([sink]),
		});

		await expect(routing.apply(plan(2))).resolves.toMatchObject({
			realized: "full",
			appliedRules: 1,
			capabilities: ["weighted-backends"],
		});
		expect(published).toHaveLength(1);
		expect(routing.select("plan:funnel:2", "user-a")).toMatchObject({
			id: expect.stringMatching(/^backend:/),
		});
		expect(sink.events.map(({ eventType }) => eventType)).toEqual([
			"routing.plan.apply",
		]);
	});

	it("denies multi-backend when requireMultiPublic is set", async () => {
		const published: FunnelPublishOptions[] = [];
		const routing = createFunnelTrafficRouting({
			overlay: overlay(published),
			requireMultiPublic: true,
		});
		await expect(routing.apply(plan(2))).resolves.toMatchObject({
			realized: "none",
			unmet: expect.arrayContaining(["funnel-multi-public"]),
		});
		expect(published).toEqual([]);
	});

	it("reports enabled Funnel without a gateway hostname as degraded", async () => {
		const sink = createInMemoryMeteringSink();
		const routing = createFunnelTrafficRouting({
			overlay: overlay([], null),
			metering: createMeteringBus([sink]),
		});

		await expect(routing.apply(plan())).resolves.toMatchObject({
			realized: "partial",
			appliedRules: 1,
			unmet: ["gateway-hostname"],
		});
		expect(sink.events.map(({ eventType }) => eventType)).toEqual([
			"routing.plan.degraded",
		]);
	});

	it("does not treat an inferred gateway hostname as confirmed exposure", async () => {
		const routing = createFunnelTrafficRouting({
			overlay: overlay([], "checkout.example.ts.net", false),
		});

		await expect(routing.apply(plan())).resolves.toMatchObject({
			realized: "none",
			unmet: ["funnel-unconfirmed"],
		});
	});

	it("does not reinterpret a remote backend URL as a local port", async () => {
		const published: FunnelPublishOptions[] = [];
		const entries = [
			{
				id: "backend:remote",
				service: "checkout",
				endpoint: "https://remote.example.test:8443/path",
			},
		];
		const routingPlan = parseRoutingPlan({
			planId: "plan:funnel:remote",
			intent: {
				service: "checkout",
				tenantId: "tenant-a",
				rules: [{ backends: entries }],
			},
			backends: entries,
			createdAt: "2026-08-03T15:00:00.000Z",
		});
		const routing = createFunnelTrafficRouting({ overlay: overlay(published) });

		await expect(routing.apply(routingPlan)).resolves.toMatchObject({
			realized: "none",
			unmet: ["backend-target"],
		});
		expect(published).toEqual([]);
	});
});

describe("Vercel traffic routing (production)", () => {
	it("denies without credentials", async () => {
		const sink = createInMemoryMeteringSink();
		const routing = createVercelTrafficRouting({
			projectIdOrName: "prj_checkout",
			metering: createMeteringBus([sink]),
		});
		await expect(routing.apply(plan(2))).resolves.toMatchObject({
			provider: "vercel",
			realized: "none",
			unmet: ["credentials"],
		});
		expect(sink.events.map(({ eventType }) => eventType)).toEqual([
			"routing.plan.deny",
		]);
	});

	it("realizes rolling release with mapped deployments", async () => {
		const calls: Array<{ url: string; method: string; body?: unknown }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			const method = (init?.method ?? "GET").toUpperCase();
			const body = isJsonString(init?.body) ? JSON.parse(init.body) : undefined;
			calls.push({ url, method, body });
			if (url.includes("/rolling-release/config") && method === "PATCH") {
				return Response.json({
					rollingRelease: { target: "production", stages: body.stages },
				});
			}
			if (url.includes("/rolling-release/start") && method === "POST") {
				return Response.json({
					rollingRelease: {
						state: "ACTIVE",
						canaryDeployment: { id: body.canaryDeploymentId },
					},
				});
			}
			if (url.endsWith("/rolling-release") && method === "GET") {
				return Response.json({ rollingRelease: { state: "ACTIVE" } });
			}
			if (url.includes("/rolling-release/config") && method === "DELETE") {
				return Response.json({ rollingRelease: null });
			}
			return Response.json({ error: "unexpected" }, { status: 500 });
		};
		const routingPlan = plan(2);
		const routing = createVercelTrafficRouting({
			token: "tok",
			projectIdOrName: "prj_checkout",
			deploymentIdsByBackend: {
				"backend:1": "dpl_stable",
				"backend:2": "dpl_canary",
			},
			mode: "rolling-release",
			fetchImpl,
		});
		await expect(routing.apply(routingPlan)).resolves.toMatchObject({
			realized: "full",
			appliedRules: 1,
			capabilities: ["weighted-backends"],
		});
		await expect(routing.status(routingPlan.planId)).resolves.toMatchObject({
			active: true,
		});
		await expect(routing.revoke(routingPlan.planId)).resolves.toEqual({
			ok: true,
			notes: [],
		});
		expect(calls.map(({ method }) => method)).toEqual([
			"PATCH",
			"POST",
			"GET",
			"DELETE",
		]);
	});

	it("realizes path rewrites via project routes stage+promote", async () => {
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			const method = (init?.method ?? "GET").toUpperCase();
			const body = isJsonString(init?.body) ? JSON.parse(init.body) : undefined;
			if (url.endsWith("/routes") && method === "PUT") {
				return Response.json({
					version: {
						id: body.routes.length === 0 ? "ver_empty" : "ver_1",
						s3Key: "k",
						lastModified: 1,
						createdBy: "t",
					},
				});
			}
			if (url.endsWith("/routes/versions") && method === "POST") {
				return Response.json({
					version: {
						id: body.id,
						s3Key: "k",
						lastModified: 2,
						createdBy: "t",
						isLive: true,
					},
				});
			}
			if (url.endsWith("/routes") && method === "GET") {
				return Response.json({
					routes: [
						{
							id: "hobo-plan-vercel-rewrite-0",
							enabled: true,
							route: {
								src: "/api/:path*",
								dest: "https://api.example.test/:path*",
							},
						},
					],
				});
			}
			return Response.json({ error: "unexpected" }, { status: 500 });
		};
		const routingPlan = parseRoutingPlan({
			planId: "plan:vercel:rewrite",
			intent: {
				service: "checkout",
				tenantId: "tenant-a",
				rules: [
					{
						match: { pathPrefix: "/api" },
						backends: [
							{
								id: "backend:api",
								service: "api",
								weight: 100,
								endpoint: "https://api.example.test",
							},
						],
					},
				],
			},
			backends: [
				{
					id: "backend:api",
					service: "api",
					weight: 100,
					endpoint: "https://api.example.test",
				},
			],
			createdAt: "2026-08-03T15:00:00.000Z",
		});
		const routing = createVercelTrafficRouting({
			token: "tok",
			projectIdOrName: "prj_checkout",
			mode: "rewrites",
			fetchImpl,
		});
		await expect(routing.apply(routingPlan)).resolves.toMatchObject({
			realized: "full",
			appliedRules: 1,
		});
		await expect(routing.status(routingPlan.planId)).resolves.toMatchObject({
			active: true,
			realized: "full",
		});
		await expect(routing.revoke(routingPlan.planId)).resolves.toEqual({
			ok: true,
			notes: [],
		});
	});
});

describe("Lakebed traffic routing (production dual-layer)", () => {
	it("fully realizes multi-backend weighted plans in-process", async () => {
		const sink = createInMemoryMeteringSink();
		const routing = createLakebedTrafficRouting({
			metering: createMeteringBus([sink]),
		});
		const routingPlan = plan(2);
		await expect(routing.apply(routingPlan)).resolves.toMatchObject({
			provider: "lakebed",
			realized: "full",
			appliedRules: 1,
			capabilities: ["weighted-backends"],
		});
		expect(routing.select(routingPlan.planId, "user-a")).toMatchObject({
			id: expect.stringMatching(/^backend:/),
		});
		await expect(routing.status(routingPlan.planId)).resolves.toMatchObject({
			active: true,
			realized: "full",
		});
		await expect(routing.revoke(routingPlan.planId)).resolves.toEqual({
			ok: true,
			notes: [],
		});
		expect(routing.select(routingPlan.planId, "user-a")).toBeNull();
		expect(sink.events.map(({ eventType }) => eventType)).toEqual([
			"routing.plan.apply",
		]);
	});

	it("emits deploy-time traffic-route program and degrades when binding fails", async () => {
		const programs: unknown[] = [];
		const routing = createLakebedTrafficRouting({
			deploy: {
				capsule: "capsule/shop",
				deploymentId: "shop",
				async applyDriverProgram(program) {
					programs.push(program);
					return { ok: false, notes: ["driver rejected"] };
				},
			},
		});
		const routingPlan = plan(2);
		await expect(routing.apply(routingPlan)).resolves.toMatchObject({
			realized: "partial",
			unmet: ["deploy-binding"],
		});
		expect(programs).toHaveLength(1);
		expect(programs[0]).toMatchObject({
			apiVersion: "hobo.driver-program/v1",
			driver: "lakebed-deploy",
			resources: [expect.objectContaining({ type: "lakebed:traffic-route" })],
		});
		expect(routing.driverProgram(routingPlan.planId)).toMatchObject({
			capsule: "capsule/shop",
		});
	});

	it("applies deploy binding for full dual-layer realization", async () => {
		const routing = createLakebedTrafficRouting({
			deploy: {
				async applyDriverProgram() {
					return { ok: true };
				},
			},
		});
		await expect(routing.apply(plan(2))).resolves.toMatchObject({
			realized: "full",
		});
	});
});
