/**
 * WP13 (plan 0024) Convex: the cloud-deployment resolver over the Management
 * API (PACT-replayed fixtures), I14 coverage and traffic profile, typed
 * refusals, wire contract and a credential-gated live lane.
 */
import { readFileSync } from "node:fs";
import {
	createBoundedFetchTransport,
	type HttpTransport,
	matchTrafficRoutingOfferings,
	parseTrafficRoutingProviderProfile,
	type ResolveRequest,
	ResolverError,
	type TransportRequest,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID,
	CONVEX_HOSTING_COVERAGE,
	CONVEX_MANAGEMENT_API_ORIGIN,
	CONVEX_RESOLVED_PRODUCT_IDS,
	CONVEX_TRAFFIC_ROUTING_ABSENT,
	CONVEX_TRAFFIC_ROUTING_PROFILE,
	CONVEX_UNRESOLVED_PRODUCTS,
	convexProductRefusal,
	convexResolverRegistry,
	type ResolverMetricPoint,
} from "../src/index.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";
import { cueVet } from "./support/cue-vet.js";
import { describeResolverConformance } from "./support/resolver-conformance.js";

const TOKEN = "convex-conformance-team-token";
const scope = { teamId: "4242", projectId: "7777" };

interface PactInteraction {
	readonly method: string;
	readonly path: string;
	readonly status: number;
	readonly body: JsonValue;
}
function loadPact(): readonly PactInteraction[] {
	const pact = parseJsonObject(
		readFileSync(
			new URL(
				"../contracts/provider-convex-management.pact.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	if (!isJsonArray(pact.interactions))
		throw new Error("Convex management pact declares no interactions");
	return pact.interactions.map((entry) => {
		if (
			!isJsonObject(entry) ||
			!isJsonObject(entry.request) ||
			!isJsonObject(entry.response) ||
			!isJsonString(entry.request.method) ||
			!isJsonString(entry.request.path) ||
			!Number.isInteger(entry.response.status) ||
			entry.response.body === undefined
		)
			throw new Error("malformed Convex pact interaction");
		return {
			method: entry.request.method,
			path: entry.request.path,
			status: Number(entry.response.status),
			body: entry.response.body,
		};
	});
}

/** A fixture world whose every answer is a recorded pact interaction. */
function pactWorld(
	overrides: {
		tokenBody?: JsonValue;
		deployments?: JsonValue;
		status?: number;
	} = {},
) {
	const interactions = loadPact();
	const calls: TransportRequest[] = [];
	const transport: HttpTransport = async (call) => {
		calls.push(call);
		const url = new URL(call.url);
		const match = interactions.find(
			(entry) => entry.method === call.method && entry.path === url.pathname,
		);
		if (!match)
			throw new Error(`undeclared Convex call ${call.method} ${url.pathname}`);
		let body = match.body;
		if (url.pathname.endsWith("token_details") && overrides.tokenBody)
			body = overrides.tokenBody;
		if (url.pathname.endsWith("list_deployments") && overrides.deployments)
			body = overrides.deployments;
		return {
			status: overrides.status ?? match.status,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		};
	};
	return {
		calls,
		transport,
		mutations: () => calls.filter((call) => call.method !== "GET").length,
	};
}

function request(
	desired: Record<string, JsonValue> = {},
	physicalId?: string,
): ResolveRequest {
	const ref = {
		slot: "api" as const,
		productId: CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID,
		logicalId: "backend",
	};
	return {
		ref: physicalId === undefined ? ref : { ...ref, physicalId },
		desired: {
			...scope,
			deploymentName: "happy-otter-123",
			deploymentType: "prod",
			...desired,
		},
		credentialRef: "vault://convex/team",
	};
}
function registry(extra: { metrics?: ResolverMetricPoint[] } = {}) {
	const points = extra.metrics;
	const base = { ...scope, resolveCredential: async () => TOKEN };
	if (!points) return convexResolverRegistry(base);
	return convexResolverRegistry({
		...base,
		metrics: {
			async metrics(batch: readonly ResolverMetricPoint[]) {
				points.push(...batch);
			},
		},
		nowMs: () => 7,
	});
}
function resolver() {
	const found = registry().get(CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID);
	if (!found) throw new Error("cloud deployment resolver is not registered");
	return found;
}
async function rejection(promise: Promise<unknown>): Promise<ResolverError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ResolverError) return error;
		throw error;
	}
	throw new Error("expected a ResolverError");
}

describe("Convex cloud deployment resolver (Management API)", () => {
	it("emits only requests declared by the consumer pact, with a bearer token at the pinned origin", async () => {
		const world = pactWorld();
		await resolver().reconcile(request(), world.transport);
		expect(
			world.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
		).toEqual([
			"GET /v1/token_details",
			"GET /v1/projects/7777/list_deployments",
		]);
		for (const call of world.calls) {
			expect(new URL(call.url).origin).toBe(CONVEX_MANAGEMENT_API_ORIGIN);
			expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
		}
	});
	it("adopts an existing deployment by name and reports it ready from observation", async () => {
		const world = pactWorld();
		const outcome = await resolver().reconcile(request(), world.transport);
		expect(outcome.action).toBe("adopt");
		expect(outcome.physicalId).toBe("happy-otter-123");
		expect(outcome.outputs).toMatchObject({
			deploymentName: "happy-otter-123",
			deploymentType: "prod",
			deploymentUrl: "https://happy-otter-123.convex.cloud",
			servingEndpoint: "https://happy-otter-123.convex.cloud",
			ready: true,
			operationConfirmed: true,
			operationTerminal: true,
			lifecycleStatus: "ready",
			codeVersionObserved: false,
		});
		expect(outcome.outputs.artifactDigest).toBeUndefined();
	});
	it("is a noop once the physical identity is pinned", async () => {
		const outcome = await resolver().reconcile(
			request({}, "happy-otter-123"),
			pactWorld().transport,
		);
		expect(outcome.action).toBe("noop");
	});
	it("refuses creation: a missing deployment is never created by guesswork", async () => {
		const error = await rejection(
			resolver().reconcile(
				request({ deploymentName: "missing-name-999" }),
				pactWorld().transport,
			),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.message).toMatch(/Remediation:/u);
	});
	it("read reports unknown (undefined) for a deployment the listing does not show", async () => {
		expect(
			await resolver().read?.(
				request({ deploymentName: "missing-name-999" }),
				pactWorld().transport,
			),
		).toBeUndefined();
	});
	it("refuses a deployment whose type differs from the desired type", async () => {
		const error = await rejection(
			resolver().reconcile(
				request({ deploymentType: "dev" }),
				pactWorld().transport,
			),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
	});
	it("refuses a token scoped to another team", async () => {
		const error = await rejection(
			resolver().reconcile(
				request(),
				pactWorld({ tokenBody: { type: "teamToken", teamId: 1, name: "x" } })
					.transport,
			),
		);
		expect(error.message).toMatch(/another team/u);
	});
	it("refuses a project token: delivery needs team scope to list deployments", async () => {
		const error = await rejection(
			resolver().reconcile(
				request(),
				pactWorld({ tokenBody: { type: "projectToken", projectId: 7777 } })
					.transport,
			),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
	});
	it("refuses desired scope that differs from the bound team/project", async () => {
		const error = await rejection(
			resolver().reconcile(request({ projectId: "1" }), pactWorld().transport),
		);
		expect(error.message).toMatch(/bound team\/project/u);
	});
	it("refuses desired parameters it does not implement instead of ignoring them", async () => {
		const error = await rejection(
			resolver().reconcile(request({ region: "eu" }), pactWorld().transport),
		);
		expect(error.message).toMatch(/desired\.region/u);
	});
	it("refuses a malformed deployment name before any call", async () => {
		const world = pactWorld();
		const error = await rejection(
			resolver().reconcile(
				request({ deploymentName: "Bad Name" }),
				world.transport,
			),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(world.calls).toHaveLength(0);
	});
	it("treats a non-2xx answer as a provider rejection", async () => {
		const error = await rejection(
			resolver().reconcile(request(), pactWorld({ status: 503 }).transport),
		);
		expect(error.message).toMatch(/HTTP 503/u);
	});
	it("treats an unparseable listing as RESOLVER_OUTPUT_UNPARSEABLE", async () => {
		const error = await rejection(
			resolver().reconcile(
				request(),
				pactWorld({ deployments: { not: "a list" } }).transport,
			),
		);
		expect(error.code).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});
	it("refuses a missing or malformed team token", async () => {
		const registryWithoutToken = convexResolverRegistry({
			...scope,
			resolveCredential: async () => "",
		});
		const error = await rejection(
			registryWithoutToken
				.get(CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID)
				?.reconcile(request(), pactWorld().transport) ?? Promise.resolve(),
		);
		expect(error.code).toBe("RESOLVER_CREDENTIAL_MISSING");
	});
	it("refuses delete: retirement is an operator action, never a guessed project deletion", async () => {
		const world = pactWorld();
		const error = await rejection(
			resolver().delete(request({}, "happy-otter-123"), world.transport),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(world.mutations()).toBe(0);
	});
	it("refuses a foreign product on the resolver", async () => {
		const foreign = {
			...request(),
			ref: { ...request().ref, productId: "convex.functions/v1" },
		};
		const error = await rejection(
			resolver().reconcile(foreign, pactWorld().transport),
		);
		expect(error.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});
	it("refuses scope options that are not identifiers at construction", () => {
		expect(() =>
			convexResolverRegistry({
				teamId: "../x",
				projectId: "7777",
				resolveCredential: async () => TOKEN,
			}),
		).toThrow(ResolverError);
	});
	it("emits resolver metrics", async () => {
		const points: ResolverMetricPoint[] = [];
		await registry({ metrics: points })
			.get(CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID)
			?.reconcile(request(), pactWorld().transport);
		expect(points[0]?.attributes).toMatchObject({
			"hobo.provider.id": "convex",
			"hobo.resolver.action": "adopt",
		});
	});
	it("outputs satisfy #ConvexCloudDeploymentOutputs with actual CUE", async () => {
		const outcome = await resolver().reconcile(
			request(),
			pactWorld().transport,
		);
		expect(() =>
			cueVet(
				"cloud_deployment.cue",
				"#ConvexCloudDeploymentOutputs",
				JSON.stringify(outcome.outputs),
			),
		).not.toThrow();
	});
});

describe("Convex traffic profile and coverage (I14)", () => {
	it("kind 'other', parses unchanged, in-process floor only", () => {
		expect(CONVEX_TRAFFIC_ROUTING_PROFILE.provider).toBe("other");
		expect(
			parseTrafficRoutingProviderProfile(
				JSON.parse(JSON.stringify(CONVEX_TRAFFIC_ROUTING_PROFILE)),
			),
		).toEqual(CONVEX_TRAFFIC_ROUTING_PROFILE);
		expect(
			CONVEX_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
		).toEqual(["inprocess.weighted"]);
		expect(CONVEX_TRAFFIC_ROUTING_ABSENT).toHaveLength(16);
	});
	it("a required canary is refused (I6)", () => {
		expect(
			matchTrafficRoutingOfferings(CONVEX_TRAFFIC_ROUTING_PROFILE, {
				features: ["edge.canary"],
				negotiation: "require",
			}).kind,
		).toBe("none");
	});
	it("resolves the cloud deployment; refuses functions, self-hosted and local forms", () => {
		expect(CONVEX_RESOLVED_PRODUCT_IDS).toEqual([
			CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID,
		]);
		expect(CONVEX_UNRESOLVED_PRODUCTS.map((entry) => entry.productId)).toEqual([
			"convex.functions/v1",
			"convex.local-accountless/v1",
			"convex.selfhosted-oci/v1",
		]);
		expect(convexProductRefusal("convex.functions/v1")?.code).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
		expect(convexProductRefusal("convex.functions/v1")?.message).toMatch(
			/RunbookExecutor|hobo:resolver/u,
		);
	});
	it("coverage satisfies #HostingCoverage with actual CUE", () => {
		expect(() =>
			cueVet(
				"hosting_coverage.cue",
				"#HostingCoverage",
				JSON.stringify(CONVEX_HOSTING_COVERAGE),
			),
		).not.toThrow();
	});
});

describeResolverConformance("convex", () => {
	const world = pactWorld();
	return {
		registry: registry(),
		coverage: CONVEX_HOSTING_COVERAGE,
		request: request({}, "happy-otter-123"),
		transport: world.transport,
		mutations: world.mutations,
		secret: TOKEN,
	};
});

const live = {
	token: process.env.CONVEX_LIVE_TEAM_TOKEN,
	teamId: process.env.CONVEX_LIVE_TEAM_ID,
	projectId: process.env.CONVEX_LIVE_PROJECT_ID,
	deploymentName: process.env.CONVEX_LIVE_DEPLOYMENT_NAME,
	deploymentType: process.env.CONVEX_LIVE_DEPLOYMENT_TYPE,
};
describe.skipIf(!Object.values(live).every((value) => Boolean(value)))(
	"Convex live lane (read-only; skipped: set CONVEX_LIVE_TEAM_TOKEN, CONVEX_LIVE_TEAM_ID, CONVEX_LIVE_PROJECT_ID, CONVEX_LIVE_DEPLOYMENT_NAME, CONVEX_LIVE_DEPLOYMENT_TYPE)",
	() => {
		it("observes the named deployment without mutating anything", async () => {
			const outcome = await convexResolverRegistry({
				teamId: String(live.teamId),
				projectId: String(live.projectId),
				resolveCredential: async () => String(live.token),
			})
				.get(CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID)
				?.read?.(
					{
						ref: {
							slot: "api",
							productId: CONVEX_CLOUD_DEPLOYMENT_PRODUCT_ID,
							logicalId: "live",
						},
						desired: {
							teamId: String(live.teamId),
							projectId: String(live.projectId),
							deploymentName: String(live.deploymentName),
							deploymentType: String(live.deploymentType),
						},
						credentialRef: "env://CONVEX_LIVE_TEAM_TOKEN",
					},
					createBoundedFetchTransport({ fetchImpl: globalThis.fetch }),
				);
			expect(outcome?.physicalId).toBe(live.deploymentName);
			expect(JSON.stringify(outcome)).not.toContain(String(live.token));
		});
	},
);
