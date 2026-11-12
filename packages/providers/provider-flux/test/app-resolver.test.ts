/**
 * WP13 (plan 0024) Flux: the observation-only flux.app/v1 resolver over the
 * public FluxOS API (PACT-replayed fixtures), I14 coverage and traffic
 * profile, typed refusals, wire contract and a gated live lane.
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
	FLUX_API_ORIGIN,
	FLUX_APP_PRODUCT_ID,
	FLUX_HOSTING_COVERAGE,
	FLUX_RESOLVED_PRODUCT_IDS,
	FLUX_TRAFFIC_ROUTING_ABSENT,
	FLUX_TRAFFIC_ROUTING_PROFILE,
	FLUX_UNRESOLVED_PRODUCTS,
	fluxProductRefusal,
	fluxResolverRegistry,
	type ResolverMetricPoint,
} from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";
import { cueVet } from "./support/cue-vet.js";
import { describeResolverConformance } from "./support/resolver-conformance.js";

const DIGEST = `sha256:${"1".repeat(64)}`;
const IMAGE = `ghcr.io/hobo/shop@${DIGEST}`;
const OWNER = "1HoBoOwnerAddressExample111111111";

interface Interaction {
	readonly path: string;
	readonly body: JsonValue;
}
function loadPact(): readonly Interaction[] {
	// SAFETY: the checked-in pact file is the fixture; its shape is asserted by every test below.
	const pact = JSON.parse(
		readFileSync(
			new URL("../contracts/provider-flux-apps.pact.json", import.meta.url),
			"utf8",
		),
	) as {
		interactions: {
			request: { path: string };
			response: { body: JsonValue };
		}[];
	};
	return pact.interactions.map((entry) => ({
		path: entry.request.path,
		body: entry.response.body,
	}));
}

function pactWorld(
	overrides: { spec?: JsonValue; locations?: JsonValue; status?: number } = {},
) {
	const interactions = loadPact();
	const calls: TransportRequest[] = [];
	const transport: HttpTransport = async (call) => {
		calls.push(call);
		const url = new URL(call.url);
		const match = interactions.find((entry) => entry.path === url.pathname);
		let body = match?.body;
		if (url.pathname.startsWith("/apps/appspecifications/")) {
			if (!match)
				body = { status: "error", data: { message: "Application not found" } };
			if (overrides.spec !== undefined) body = overrides.spec;
		}
		if (url.pathname.startsWith("/apps/location/")) {
			if (!match) body = { status: "success", data: [] };
			if (overrides.locations !== undefined) body = overrides.locations;
		}
		if (body === undefined)
			throw new Error(`undeclared Flux call ${url.pathname}`);
		return {
			status: overrides.status ?? 200,
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

function spec(changes: JsonObject): JsonValue {
	// SAFETY: the first pact interaction is the specification envelope.
	const base = loadPact()[0]?.body as { status: string; data: JsonObject };
	return { status: "success", data: { ...base.data, ...changes } };
}

function request(
	desired: JsonObject = {},
	physicalId?: string,
): ResolveRequest {
	const ref = {
		slot: "service" as const,
		productId: FLUX_APP_PRODUCT_ID,
		logicalId: "shop",
	};
	return {
		ref: physicalId === undefined ? ref : { ...ref, physicalId },
		desired: {
			appName: "hoboshop",
			owner: OWNER,
			images: { web: IMAGE },
			...desired,
		},
		credentialRef: "vault://flux/unused",
	};
}
function resolver() {
	const found = fluxResolverRegistry().get(FLUX_APP_PRODUCT_ID);
	if (!found) throw new Error("flux app resolver is not registered");
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

describe("Flux app resolver (public FluxOS API, observation only)", () => {
	it("issues only the two GETs declared by the consumer pact, unauthenticated, at the pinned origin", async () => {
		const world = pactWorld();
		await resolver().reconcile(request(), world.transport);
		expect(
			world.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
		).toEqual([
			"GET /apps/appspecifications/hoboshop",
			"GET /apps/location/hoboshop",
		]);
		for (const call of world.calls) {
			expect(new URL(call.url).origin).toBe(FLUX_API_ORIGIN);
			expect(call.headers.authorization).toBeUndefined();
			expect(call.headers.zelidauth).toBeUndefined();
		}
	});
	it("adopts a matching app and is ready when enough instances run", async () => {
		const outcome = await resolver().reconcile(
			request(),
			pactWorld().transport,
		);
		expect(outcome.action).toBe("adopt");
		expect(outcome.physicalId).toBe("hoboshop");
		expect(outcome.outputs).toMatchObject({
			appName: "hoboshop",
			owner: OWNER,
			instances: 3,
			runningInstances: 3,
			artifactDigest: DIGEST,
			ready: true,
			operationConfirmed: true,
			operationTerminal: true,
			lifecycleStatus: "ready",
		});
	});
	it("never copies environment parameters into outputs", async () => {
		const outcome = await resolver().reconcile(
			request(),
			pactWorld().transport,
		);
		expect(JSON.stringify(outcome)).not.toContain("PUBLIC_MODE");
	});
	it("is a noop once the physical identity is pinned", async () => {
		const outcome = await resolver().reconcile(
			request({}, "hoboshop"),
			pactWorld().transport,
		);
		expect(outcome.action).toBe("noop");
	});
	it("reports pending, never ready, while fewer instances run than registered (I5)", async () => {
		const outcome = await resolver().reconcile(
			request(),
			pactWorld({
				locations: {
					status: "success",
					data: [{ name: "hoboshop", ip: "203.0.113.10:16127" }],
				},
			}).transport,
		);
		expect(outcome.outputs).toMatchObject({
			ready: false,
			lifecycleStatus: "pending",
			runningInstances: 1,
		});
	});
	it("honours a stricter desired minInstances", async () => {
		const outcome = await resolver().reconcile(
			request({ minInstances: 5 }),
			pactWorld().transport,
		);
		expect(outcome.outputs.ready).toBe(false);
	});
	it("counts each node once even if listed twice", async () => {
		const outcome = await resolver().reconcile(
			request(),
			pactWorld({
				locations: {
					status: "success",
					data: [
						{ name: "hoboshop", ip: "203.0.113.10:16127" },
						{ name: "hoboshop", ip: "203.0.113.10:16127" },
						{ name: "hoboshop", ip: "203.0.113.11:16127" },
					],
				},
			}).transport,
		);
		expect(outcome.outputs.runningInstances).toBe(2);
	});
	it("refuses registration of an absent app: it needs the owner's signature and payment", async () => {
		const error = await rejection(
			resolver().reconcile(
				request({ appName: "missingapp" }),
				pactWorld().transport,
			),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.message).toMatch(/Remediation:/u);
	});
	it("read reports unknown (undefined) for an app FluxOS does not know", async () => {
		expect(
			await resolver().read?.(
				request({ appName: "missingapp" }),
				pactWorld().transport,
			),
		).toBeUndefined();
	});
	it("refuses an app owned by someone else: Flux app names are global", async () => {
		const error = await rejection(
			resolver().reconcile(
				request(),
				pactWorld({ spec: spec({ owner: "1Someone" }) }).transport,
			),
		);
		expect(error.message).toMatch(/another owner/u);
	});
	it("refuses an image drift: an update needs an owner-signed appupdate", async () => {
		const error = await rejection(
			resolver().reconcile(
				request({
					images: { web: `ghcr.io/hobo/shop@sha256:${"2".repeat(64)}` },
				}),
				pactWorld().transport,
			),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.message).toMatch(/appupdate/u);
	});
	it("refuses a desired image that is not digest-pinned (I1: promote, never rebuild)", async () => {
		const world = pactWorld();
		const error = await rejection(
			resolver().reconcile(
				request({ images: { web: "ghcr.io/hobo/shop:latest" } }),
				world.transport,
			),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(world.calls).toHaveLength(0);
	});
	it("refuses a component set that differs from the registered compose", async () => {
		const error = await rejection(
			resolver().reconcile(
				request({ images: { web: IMAGE, worker: IMAGE } }),
				pactWorld().transport,
			),
		);
		expect(error.message).toMatch(/components/u);
	});
	it("omits artifactDigest when several components make it ambiguous", async () => {
		const twoComponents = spec({
			compose: [
				{ name: "web", repotag: IMAGE },
				{ name: "worker", repotag: IMAGE },
			],
		});
		const outcome = await resolver().reconcile(
			request({ images: { web: IMAGE, worker: IMAGE } }),
			pactWorld({ spec: twoComponents }).transport,
		);
		expect(outcome.outputs.artifactDigest).toBeUndefined();
		expect(outcome.outputs.componentDigests).toEqual({
			web: DIGEST,
			worker: DIGEST,
		});
	});
	it("treats a non-2xx answer as a provider rejection", async () => {
		const error = await rejection(
			resolver().reconcile(request(), pactWorld({ status: 502 }).transport),
		);
		expect(error.message).toMatch(/HTTP 502/u);
	});
	it("treats a malformed specification as RESOLVER_OUTPUT_UNPARSEABLE", async () => {
		const error = await rejection(
			resolver().reconcile(
				request(),
				pactWorld({ spec: { status: "success", data: { name: "hoboshop" } } })
					.transport,
			),
		);
		expect(error.code).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});
	it("refuses a specification for another app name", async () => {
		const error = await rejection(
			resolver().reconcile(
				request(),
				pactWorld({ spec: spec({ name: "otherapp" }) }).transport,
			),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
	});
	it("refuses an invalid app name before any call", async () => {
		const world = pactWorld();
		await rejection(
			resolver().reconcile(request({ appName: "../admin" }), world.transport),
		);
		expect(world.calls).toHaveLength(0);
	});
	it("refuses desired parameters it does not implement", async () => {
		const error = await rejection(
			resolver().reconcile(
				request({ geolocation: "eu" }),
				pactWorld().transport,
			),
		);
		expect(error.message).toMatch(/desired\.geolocation/u);
	});
	it("refuses delete: removal is an owner-signed act or expiry", async () => {
		const world = pactWorld();
		const error = await rejection(
			resolver().delete(request({}, "hoboshop"), world.transport),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(world.mutations()).toBe(0);
	});
	it("emits resolver metrics", async () => {
		const points: ResolverMetricPoint[] = [];
		await fluxResolverRegistry({
			metrics: {
				async metrics(batch) {
					points.push(...batch);
				},
			},
			nowMs: () => 9,
		})
			.get(FLUX_APP_PRODUCT_ID)
			?.reconcile(request(), pactWorld().transport);
		expect(points[0]?.attributes).toMatchObject({
			"hobo.provider.id": "flux",
			"hobo.resolver.action": "adopt",
		});
	});
	it("outputs satisfy #FluxAppOutputs with actual CUE", async () => {
		const outcome = await resolver().reconcile(
			request(),
			pactWorld().transport,
		);
		expect(() =>
			cueVet(
				"app_resolver.cue",
				"#FluxAppOutputs",
				JSON.stringify(outcome.outputs),
			),
		).not.toThrow();
	});
});

describe("Flux traffic profile and coverage (I14)", () => {
	it("kind 'other', parses unchanged, in-process floor only", () => {
		expect(FLUX_TRAFFIC_ROUTING_PROFILE.provider).toBe("other");
		expect(
			parseTrafficRoutingProviderProfile(
				JSON.parse(JSON.stringify(FLUX_TRAFFIC_ROUTING_PROFILE)),
			),
		).toEqual(FLUX_TRAFFIC_ROUTING_PROFILE);
		expect(
			FLUX_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
		).toEqual(["inprocess.weighted"]);
		expect(FLUX_TRAFFIC_ROUTING_ABSENT).toHaveLength(16);
	});
	it("a required weighted load balancer is refused (I6)", () => {
		expect(
			matchTrafficRoutingOfferings(FLUX_TRAFFIC_ROUTING_PROFILE, {
				features: ["lb.weighted"],
				negotiation: "require",
			}).kind,
		).toBe("none");
	});
	it("resolves flux.app/v1 and refuses Orbit git mode with a typed reason", () => {
		expect(FLUX_RESOLVED_PRODUCT_IDS).toEqual([FLUX_APP_PRODUCT_ID]);
		expect(FLUX_UNRESOLVED_PRODUCTS.map((entry) => entry.productId)).toEqual([
			"flux.orbit-git/v1",
		]);
		expect(fluxProductRefusal("flux.orbit-git/v1")?.code).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});
	it("coverage satisfies #HostingCoverage with actual CUE", () => {
		expect(() =>
			cueVet(
				"hosting_coverage.cue",
				"#HostingCoverage",
				JSON.stringify(FLUX_HOSTING_COVERAGE),
			),
		).not.toThrow();
	});
});

describeResolverConformance("flux", () => {
	const world = pactWorld();
	return {
		registry: fluxResolverRegistry(),
		coverage: FLUX_HOSTING_COVERAGE,
		request: request({}, "hoboshop"),
		transport: world.transport,
		mutations: world.mutations,
	};
});

const live = {
	enabled: process.env.HOBO_FLUX_LIVE,
	appName: process.env.FLUX_LIVE_APP_NAME,
	owner: process.env.FLUX_LIVE_APP_OWNER,
	component: process.env.FLUX_LIVE_COMPONENT,
	image: process.env.FLUX_LIVE_IMAGE,
};
describe.skipIf(
	!(
		live.enabled === "1" &&
		live.appName &&
		live.owner &&
		live.component &&
		live.image
	),
)(
	"Flux live lane (read-only, public API; skipped: set HOBO_FLUX_LIVE=1, FLUX_LIVE_APP_NAME, FLUX_LIVE_APP_OWNER, FLUX_LIVE_COMPONENT, FLUX_LIVE_IMAGE)",
	() => {
		it("observes the named app without mutating anything", async () => {
			const outcome = await fluxResolverRegistry()
				.get(FLUX_APP_PRODUCT_ID)
				?.read?.(
					request({
						appName: String(live.appName),
						owner: String(live.owner),
						images: { [String(live.component)]: String(live.image) },
					}),
					createBoundedFetchTransport({ fetchImpl: globalThis.fetch }),
				);
			expect(outcome?.physicalId).toBe(live.appName);
		});
	},
);
