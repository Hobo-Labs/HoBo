/**
 * WP13 (plan 0024) Railway coverage: I14 realization path + traffic profile,
 * typed refusals, telemetry, resolver conformance on fixtures, and a
 * credential-gated read-only live lane.
 */

import { fromJson, toJson } from "@bufbuild/protobuf";
import {
	createBoundedFetchTransport,
	type HttpTransport,
	matchTrafficRoutingOfferings,
	parseTrafficRoutingProviderProfile,
	type ResolveRequest,
	type TransportRequest,
	type TransportResponse,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import { HostingCoverageSchema } from "../src/_generated/hosting_coverage_pb.js";
import {
	RAILWAY_HOSTING_COVERAGE,
	RAILWAY_RESOLVED_PRODUCT_IDS,
	RAILWAY_SERVICE_PRODUCT_ID,
	RAILWAY_TRAFFIC_ROUTING_ABSENT,
	RAILWAY_TRAFFIC_ROUTING_PROFILE,
	RAILWAY_UNRESOLVED_PRODUCTS,
	type ResolverMetricPoint,
	railwayProductRefusal,
	railwayResolverRegistry,
} from "../src/index.js";
import { isJsonString, type JsonObject, parseJsonObject } from "../src/json.js";
import { cueVet } from "./support/cue-vet.js";
import { describeResolverConformance } from "./support/resolver-conformance.js";

const TOKEN = "railway-conformance-project-token";
const scope = { projectId: "project-one", environmentId: "environment-one" };

function respond(data: JsonObject): TransportResponse {
	return { status: 200, headers: {}, body: JSON.stringify({ data }) };
}

/** A converged Railway world: one SUCCESS deployment at the pinned commit. */
function convergedWorld() {
	const calls: TransportRequest[] = [];
	const transport: HttpTransport = async (call) => {
		calls.push(call);
		const query = parseJsonObject(call.body ?? "").query;
		if (!isJsonString(query)) throw new Error("missing GraphQL query");
		if (query.includes("hoboProjectToken"))
			return respond({ projectToken: { ...scope } });
		if (query.includes("hoboService("))
			return respond({
				service: { id: "service-one", name: "app", projectId: scope.projectId },
			});
		if (query.includes("hoboDeployment("))
			return respond({
				deployment: {
					id: "deployment-one",
					...scope,
					serviceId: "service-one",
					status: "SUCCESS",
					deploymentStopped: false,
					url: "https://app.up.railway.app/",
					meta: { commitHash: "a".repeat(40) },
				},
			});
		throw new Error(`unexpected Railway call: ${query}`);
	};
	return {
		transport,
		mutations: () =>
			calls.filter((call) =>
				String(parseJsonObject(call.body ?? "").query).startsWith("mutation"),
			).length,
	};
}

const convergedRequest: ResolveRequest = {
	ref: {
		slot: "service",
		productId: RAILWAY_SERVICE_PRODUCT_ID,
		logicalId: "app",
		physicalId: "deployment-one",
	},
	desired: {
		...scope,
		serviceId: "service-one",
		deploymentId: "deployment-one",
		commitSha: "a".repeat(40),
	},
	credentialRef: "vault://railway/project",
};

describe("Railway traffic routing profile (I14, ADR-0144)", () => {
	it("kind is 'other' because the core union has no railway member", () => {
		expect(RAILWAY_TRAFFIC_ROUTING_PROFILE.provider).toBe("other");
	});
	it("parses unchanged through the core profile boundary", () => {
		expect(
			parseTrafficRoutingProviderProfile(
				JSON.parse(JSON.stringify(RAILWAY_TRAFFIC_ROUTING_PROFILE)),
			),
		).toEqual(RAILWAY_TRAFFIC_ROUTING_PROFILE);
	});
	it("declares only the in-process floor; every other offering is absent with a reason", () => {
		expect(
			RAILWAY_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
		).toEqual(["inprocess.weighted"]);
		expect(RAILWAY_TRAFFIC_ROUTING_ABSENT).toHaveLength(16);
		expect(RAILWAY_HOSTING_COVERAGE.traffic.absent).toEqual(
			RAILWAY_TRAFFIC_ROUTING_ABSENT,
		);
	});
	it("a required edge canary is refused, never faked (I6)", () => {
		expect(
			matchTrafficRoutingOfferings(RAILWAY_TRAFFIC_ROUTING_PROFILE, {
				features: ["edge.canary"],
				negotiation: "require",
			}).kind,
		).toBe("none");
		expect(
			matchTrafficRoutingOfferings(RAILWAY_TRAFFIC_ROUTING_PROFILE, {
				features: ["inprocess.weighted"],
				negotiation: "require",
			}).kind,
		).toBe("full");
	});
});

describe("Railway hosting coverage (I14)", () => {
	it("resolves the service product and refuses the rest with typed reasons", () => {
		expect(RAILWAY_RESOLVED_PRODUCT_IDS).toEqual([RAILWAY_SERVICE_PRODUCT_ID]);
		expect(RAILWAY_UNRESOLVED_PRODUCTS.map((entry) => entry.productId)).toEqual(
			["railway.queue/v1", "railway.redis/v1"],
		);
		expect(RAILWAY_HOSTING_COVERAGE.providerId).toBe("railway");
	});
	it("railwayProductRefusal returns typed RESOLVER_PRODUCT_UNSUPPORTED", () => {
		const refusal = railwayProductRefusal("railway.redis/v1");
		expect(refusal?.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(refusal?.message).toMatch(/Remediation:/u);
		expect(railwayProductRefusal(RAILWAY_SERVICE_PRODUCT_ID)).toBeUndefined();
	});
	it("registry emits resolver metrics through an injected sink", async () => {
		const points: ResolverMetricPoint[] = [];
		const world = convergedWorld();
		const registry = railwayResolverRegistry({
			...scope,
			resolveCredential: async () => TOKEN,
			metrics: {
				async metrics(batch) {
					points.push(...batch);
				},
			},
			nowMs: () => 42,
		});
		await registry
			.get(RAILWAY_SERVICE_PRODUCT_ID)
			?.reconcile(convergedRequest, world.transport);
		expect(points[0]?.attributes).toMatchObject({
			"hobo.provider.id": "railway",
			"hobo.resolver.operation": "reconcile",
			"hobo.resolver.outcome": "ok",
		});
	});
});

describe("Railway hosting coverage wire contract (protobuf + CUE)", () => {
	it("round-trips through the generated HostingCoverage protobuf", () => {
		const wire = JSON.parse(JSON.stringify(RAILWAY_HOSTING_COVERAGE));
		expect(
			toJson(HostingCoverageSchema, fromJson(HostingCoverageSchema, wire)),
		).toEqual(wire);
	});
	it("satisfies #HostingCoverage with actual CUE", () => {
		expect(() =>
			cueVet(
				"hosting_coverage.cue",
				"#HostingCoverage",
				JSON.stringify(RAILWAY_HOSTING_COVERAGE),
			),
		).not.toThrow();
	});
	it("CUE rejects a coverage that drops an offering declaration", () => {
		const broken = JSON.parse(JSON.stringify(RAILWAY_HOSTING_COVERAGE));
		broken.traffic.absent.pop();
		expect(() =>
			cueVet(
				"hosting_coverage.cue",
				"#HostingCoverage",
				JSON.stringify(broken),
			),
		).toThrow();
	});
});

describeResolverConformance("railway", () => {
	const world = convergedWorld();
	return {
		registry: railwayResolverRegistry({
			...scope,
			resolveCredential: async () => TOKEN,
		}),
		coverage: RAILWAY_HOSTING_COVERAGE,
		request: convergedRequest,
		transport: world.transport,
		mutations: world.mutations,
		secret: TOKEN,
	};
});

const live = {
	token: process.env.RAILWAY_LIVE_PROJECT_TOKEN,
	projectId: process.env.RAILWAY_LIVE_PROJECT_ID,
	environmentId: process.env.RAILWAY_LIVE_ENVIRONMENT_ID,
	serviceId: process.env.RAILWAY_LIVE_SERVICE_ID,
	deploymentId: process.env.RAILWAY_LIVE_DEPLOYMENT_ID,
};
const liveReady = Object.values(live).every((value) => Boolean(value));

describe.skipIf(!liveReady)(
	"Railway live lane (read-only; skipped: set RAILWAY_LIVE_PROJECT_TOKEN, RAILWAY_LIVE_PROJECT_ID, RAILWAY_LIVE_ENVIRONMENT_ID, RAILWAY_LIVE_SERVICE_ID, RAILWAY_LIVE_DEPLOYMENT_ID)",
	() => {
		it("observes the named deployment without mutating it", async () => {
			const registry = railwayResolverRegistry({
				projectId: String(live.projectId),
				environmentId: String(live.environmentId),
				resolveCredential: async () => String(live.token),
			});
			const outcome = await registry.get(RAILWAY_SERVICE_PRODUCT_ID)?.read?.(
				{
					ref: {
						slot: "service",
						productId: RAILWAY_SERVICE_PRODUCT_ID,
						logicalId: "live",
						physicalId: String(live.deploymentId),
					},
					desired: {
						projectId: String(live.projectId),
						environmentId: String(live.environmentId),
						serviceId: String(live.serviceId),
					},
					credentialRef: "env://RAILWAY_LIVE_PROJECT_TOKEN",
				},
				createBoundedFetchTransport({ fetchImpl: globalThis.fetch }),
			);
			expect(outcome?.physicalId).toBe(live.deploymentId);
			expect(JSON.stringify(outcome)).not.toContain(String(live.token));
		});
	},
);
