/**
 * WP13 (plan 0024) Webernetes: the local webernetes.pod/v1 resolver over the
 * injected station-host seam (PACT-replayed fixtures), a real local HTTP probe,
 * I14 coverage and traffic profile, typed refusals and the wire contract.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	createBoundedFetchTransport,
	type HttpTransport,
	matchTrafficRoutingOfferings,
	parseTrafficRoutingProviderProfile,
	type ResolveRequest,
	ResolverError,
	type TransportRequest,
} from "@hobo/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ResolverMetricPoint,
	WEBERNETES_HOSTING_COVERAGE,
	WEBERNETES_POD_PRODUCT_ID,
	WEBERNETES_RESOLVED_PRODUCT_IDS,
	WEBERNETES_TRAFFIC_ROUTING_ABSENT,
	WEBERNETES_TRAFFIC_ROUTING_PROFILE,
	WEBERNETES_UNRESOLVED_PRODUCTS,
	type WebernetesStationHost,
	type WebernetesStationRecord,
	webernetesProductRefusal,
	webernetesResolverRegistry,
} from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";
import { cueVet } from "./support/cue-vet.js";
import { describeResolverConformance } from "./support/resolver-conformance.js";

const DIGEST = `sha256:${"3".repeat(64)}`;

interface Interaction {
	readonly description: string;
	readonly type: string;
	readonly response: JsonValue;
}
function loadPact(): readonly Interaction[] {
	const pact = JSON.parse(
		readFileSync(
			new URL(
				"../contracts/provider-webernetes-station-host.pact.json",
				import.meta.url,
			),
			"utf8",
		),
	) as {
		interactions: {
			description: string;
			request: { type: string };
			response: { body: JsonValue };
		}[];
	};
	return pact.interactions.map((entry) => ({
		description: entry.description,
		type: entry.request.type,
		response: entry.response.body,
	}));
}
function pactBody(description: string): JsonValue {
	const found = loadPact().find((entry) => entry.description === description);
	if (!found) throw new Error(`pact has no interaction ${description}`);
	return found.response;
}

/** A local station host driven by the pact's recorded messages. */
function pactWorld(
	settings: {
		initially?: "absent" | "running" | "released";
		probeStatus?: number;
		describeAfterProvision?: JsonValue;
		releaseLeavesRunning?: boolean;
		hostThrows?: boolean;
	} = {},
) {
	let state = settings.initially ?? "absent";
	const log: string[] = [];
	const calls: TransportRequest[] = [];
	const host: WebernetesStationHost = {
		async provision({ stationId }) {
			log.push(`provision ${stationId}`);
			if (settings.hostThrows) throw new Error("dev server not running");
			state = "running";
			return pactBody("provision a local station") as {
				stationUrl: string;
				claimUrl: string;
			};
		},
		async describe({ stationId }) {
			log.push(`describe ${stationId}`);
			if (settings.hostThrows) throw new Error("dev server not running");
			if (state === "absent") return undefined;
			if (state === "released")
				return pactBody(
					"describe a released station",
				) as WebernetesStationRecord;
			if (settings.describeAfterProvision !== undefined)
				return settings.describeAfterProvision as WebernetesStationRecord;
			return pactBody("describe a running station") as WebernetesStationRecord;
		},
		async release({ stationId }) {
			log.push(`release ${stationId}`);
			if (!settings.releaseLeavesRunning) state = "released";
		},
	};
	const transport: HttpTransport = async (call) => {
		calls.push(call);
		return { status: settings.probeStatus ?? 200, headers: {}, body: "ok" };
	};
	return {
		host,
		log,
		calls,
		transport,
		mutations: () =>
			log.filter((entry) => !entry.startsWith("describe")).length,
	};
}

function request(
	desired: JsonObject = {},
	physicalId?: string,
): ResolveRequest {
	return {
		ref: {
			slot: "service",
			productId: WEBERNETES_POD_PRODUCT_ID,
			logicalId: "shop",
			...(physicalId === undefined ? {} : { physicalId }),
		},
		desired,
		credentialRef: "local://webernetes/none",
	};
}
function resolverFor(world: ReturnType<typeof pactWorld>) {
	const found = webernetesResolverRegistry({ host: world.host }).get(
		WEBERNETES_POD_PRODUCT_ID,
	);
	if (!found) throw new Error("pod resolver is not registered");
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

describe("Webernetes pod resolver (local station host)", () => {
	it("provisions an absent station, then confirms it by observation and probe", async () => {
		const world = pactWorld();
		const outcome = await resolverFor(world).reconcile(
			request(),
			world.transport,
		);
		expect(world.log).toEqual([
			"describe shop",
			"provision shop",
			"describe shop",
		]);
		expect(outcome.action).toBe("create");
		expect(outcome.physicalId).toBe("shop");
		expect(outcome.outputs).toMatchObject({
			stationId: "shop",
			stationUrl: "http://127.0.0.1:4321/api/anon/host/shop/",
			servingEndpoint: "http://127.0.0.1:4321/api/anon/host/shop/",
			locality: "loopback",
			probeStatus: 200,
			artifactDigest: DIGEST,
			ready: true,
			operationConfirmed: true,
			operationTerminal: true,
			lifecycleStatus: "ready",
		});
	});
	it("probes only the parsed local station URL with GET and no credential", async () => {
		const world = pactWorld();
		await resolverFor(world).reconcile(request(), world.transport);
		expect(world.calls).toHaveLength(1);
		expect(world.calls[0]).toMatchObject({
			method: "GET",
			url: "http://127.0.0.1:4321/api/anon/host/shop/",
		});
		expect(world.calls[0]?.headers.authorization).toBeUndefined();
	});
	it("never records the claim URL (a capability) in outputs", async () => {
		const world = pactWorld();
		const outcome = await resolverFor(world).reconcile(
			request(),
			world.transport,
		);
		expect(JSON.stringify(outcome)).not.toContain("/claim");
	});
	it("adopts a running station without provisioning again (convergent)", async () => {
		const world = pactWorld({ initially: "running" });
		const outcome = await resolverFor(world).reconcile(
			request(),
			world.transport,
		);
		expect(outcome.action).toBe("adopt");
		expect(world.log).toEqual(["describe shop"]);
	});
	it("reports pending, never ready, when the probe fails (I5)", async () => {
		const world = pactWorld({ initially: "running", probeStatus: 503 });
		const outcome = await resolverFor(world).reconcile(
			request(),
			world.transport,
		);
		expect(outcome.outputs).toMatchObject({
			ready: false,
			lifecycleStatus: "pending",
			probeStatus: 503,
		});
	});
	it("reports pending when the probe cannot connect", async () => {
		const world = pactWorld({ initially: "running" });
		const outcome = await resolverFor(world).reconcile(request(), async () => {
			throw new Error("ECONNREFUSED");
		});
		expect(outcome.outputs).toMatchObject({ ready: false, probeStatus: 0 });
	});
	it("refuses an artifact replacement in place: a new version needs a new station", async () => {
		const world = pactWorld({ initially: "running" });
		const error = await rejection(
			resolverFor(world).reconcile(
				request({ artifactDigest: `sha256:${"4".repeat(64)}` }),
				world.transport,
			),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.message).toMatch(/Remediation:/u);
	});
	it("stays pending while the host has not reported the desired artifact", async () => {
		const world = pactWorld({
			describeAfterProvision: {
				state: "running",
				stationUrl: "http://127.0.0.1:4321/api/anon/host/shop/",
				claimUrl: "http://127.0.0.1:4321/api/anon/host/shop/claim",
			},
		});
		const outcome = await resolverFor(world).reconcile(
			request({ artifactDigest: DIGEST }),
			world.transport,
		);
		expect(outcome.outputs.ready).toBe(false);
		expect(outcome.outputs.artifactDigest).toBeUndefined();
	});
	it("refuses a station URL that is not local (the host cannot invent a public endpoint)", async () => {
		const world = pactWorld({
			initially: "running",
			describeAfterProvision: {
				state: "running",
				stationUrl: "https://shop.example.com/",
				claimUrl: "https://shop.example.com/claim",
			},
		});
		const error = await rejection(
			resolverFor(world).reconcile(request(), world.transport),
		);
		expect(error.code).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
		expect(world.calls).toHaveLength(0);
	});
	it("reports a private-network station without claiming a serving endpoint core would reject", async () => {
		const world = pactWorld({
			initially: "running",
			describeAfterProvision: {
				state: "running",
				stationUrl: "http://192.168.1.20:4321/shop/",
				claimUrl: "http://192.168.1.20:4321/shop/claim",
			},
		});
		const outcome = await resolverFor(world).reconcile(
			request(),
			world.transport,
		);
		expect(outcome.outputs.locality).toBe("private-network");
		expect(outcome.outputs.servingEndpoint).toBeUndefined();
	});
	it("maps a failing host to a typed provider rejection with remediation", async () => {
		const world = pactWorld({ hostThrows: true });
		const error = await rejection(
			resolverFor(world).reconcile(request(), world.transport),
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.message).toMatch(/local station host/u);
	});
	it("read is undefined (unknown) for a station the host never stood up", async () => {
		const world = pactWorld();
		expect(
			await resolverFor(world).read?.(request(), world.transport),
		).toBeUndefined();
	});
	it("delete releases and confirms absence by observation", async () => {
		const world = pactWorld({ initially: "running" });
		const resolver = resolverFor(world);
		await resolver.delete(request({}, "shop"), world.transport);
		expect(world.log).toEqual(["release shop", "describe shop"]);
		const after = await resolver.read?.(request({}, "shop"), world.transport);
		expect(after?.outputs).toMatchObject({
			absenceConfirmed: true,
			operationTerminal: true,
			lifecycleStatus: "absent",
			ready: false,
		});
	});
	it("delete refuses when the host still reports the station running", async () => {
		const world = pactWorld({
			initially: "running",
			releaseLeavesRunning: true,
		});
		const error = await rejection(
			resolverFor(world).delete(request({}, "shop"), world.transport),
		);
		expect(error.message).toMatch(/not confirmed/u);
	});
	it("refuses a released station on reconcile rather than resurrecting it silently", async () => {
		const world = pactWorld({ initially: "released" });
		const error = await rejection(
			resolverFor(world).reconcile(request(), world.transport),
		);
		expect(error.message).toMatch(/released/u);
	});
	it("refuses desired parameters it does not implement", async () => {
		const world = pactWorld();
		const error = await rejection(
			resolverFor(world).reconcile(request({ replicas: 3 }), world.transport),
		);
		expect(error.message).toMatch(/desired\.replicas/u);
	});
	it("refuses a resolver without a station host at construction", () => {
		expect(() =>
			webernetesResolverRegistry({} as { host: WebernetesStationHost }),
		).toThrow(ResolverError);
	});
	it("emits resolver metrics", async () => {
		const points: ResolverMetricPoint[] = [];
		const world = pactWorld();
		await webernetesResolverRegistry({
			host: world.host,
			metrics: {
				async metrics(batch) {
					points.push(...batch);
				},
			},
			nowMs: () => 3,
		})
			.get(WEBERNETES_POD_PRODUCT_ID)
			?.reconcile(request(), world.transport);
		expect(points[0]?.attributes).toMatchObject({
			"hobo.provider.id": "webernetes",
			"hobo.resolver.action": "create",
		});
	});
	it("outputs satisfy #WebernetesPodOutputs with actual CUE", async () => {
		const world = pactWorld();
		const outcome = await resolverFor(world).reconcile(
			request(),
			world.transport,
		);
		expect(() =>
			cueVet("pod_resolver.cue", "#WebernetesPodOutputs", outcome.outputs),
		).not.toThrow();
	});
});

describe("Webernetes station-host PACT messages satisfy the CUE wire contract", () => {
	it.each([
		"describe a running station",
		"describe a released station",
	])("%s is a #WebernetesStationRecord", (description) => {
		expect(() =>
			cueVet(
				"pod_resolver.cue",
				"#WebernetesStationRecord",
				pactBody(description),
			),
		).not.toThrow();
	});
	it("CUE rejects a running record without a station URL", () => {
		expect(() =>
			cueVet("pod_resolver.cue", "#WebernetesStationRecord", {
				state: "running",
			}),
		).toThrow();
	});
});

describe("Webernetes real local HTTP lane", () => {
	let server: Server | undefined;
	afterEach(async () => {
		await new Promise<void>((resolve) => {
			if (!server) return resolve();
			server.close(() => resolve());
		});
		server = undefined;
	});
	it("probes a real loopback station through the bounded fetch transport", async () => {
		server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("station up");
		});
		await new Promise<void>((resolve) =>
			server?.listen(0, "127.0.0.1", resolve),
		);
		const port = (server.address() as AddressInfo).port;
		const stationUrl = `http://127.0.0.1:${port}/api/anon/host/shop/`;
		let running = false;
		const host: WebernetesStationHost = {
			async provision() {
				running = true;
				return { stationUrl, claimUrl: `${stationUrl}claim` };
			},
			async describe() {
				return running
					? { state: "running", stationUrl, claimUrl: `${stationUrl}claim` }
					: undefined;
			},
			async release() {
				running = false;
			},
		};
		const outcome = await webernetesResolverRegistry({ host })
			.get(WEBERNETES_POD_PRODUCT_ID)
			?.reconcile(
				request(),
				createBoundedFetchTransport({ fetchImpl: globalThis.fetch }),
			);
		expect(outcome?.outputs).toMatchObject({ ready: true, probeStatus: 200 });
	});
});

describe("Webernetes traffic profile and coverage (I14)", () => {
	it("kind 'other', parses unchanged, in-process floor only", () => {
		expect(WEBERNETES_TRAFFIC_ROUTING_PROFILE.provider).toBe("other");
		expect(
			parseTrafficRoutingProviderProfile(
				JSON.parse(JSON.stringify(WEBERNETES_TRAFFIC_ROUTING_PROFILE)),
			),
		).toEqual(WEBERNETES_TRAFFIC_ROUTING_PROFILE);
		expect(
			WEBERNETES_TRAFFIC_ROUTING_PROFILE.offerings.map((entry) => entry.id),
		).toEqual(["inprocess.weighted"]);
		expect(WEBERNETES_TRAFFIC_ROUTING_ABSENT).toHaveLength(16);
	});
	it("a required public funnel is refused: a local yard is never public (I6)", () => {
		expect(
			matchTrafficRoutingOfferings(WEBERNETES_TRAFFIC_ROUTING_PROFILE, {
				features: ["overlay.funnel"],
				negotiation: "require",
			}).kind,
		).toBe("none");
	});
	it("resolves the pod; refuses kv and queue with typed reasons", () => {
		expect(WEBERNETES_RESOLVED_PRODUCT_IDS).toEqual([
			WEBERNETES_POD_PRODUCT_ID,
		]);
		expect(
			WEBERNETES_UNRESOLVED_PRODUCTS.map((entry) => entry.productId),
		).toEqual(["webernetes.kv/v1", "webernetes.queue/v1"]);
		expect(webernetesProductRefusal("webernetes.kv/v1")?.code).toBe(
			"RESOLVER_PRODUCT_UNSUPPORTED",
		);
	});
	it("coverage satisfies #HostingCoverage with actual CUE", () => {
		expect(() =>
			cueVet(
				"hosting_coverage.cue",
				"#HostingCoverage",
				WEBERNETES_HOSTING_COVERAGE,
			),
		).not.toThrow();
	});
});

describeResolverConformance("webernetes", () => {
	const world = pactWorld({ initially: "running" });
	return {
		registry: webernetesResolverRegistry({ host: world.host }),
		coverage: WEBERNETES_HOSTING_COVERAGE,
		request: request({}, "shop"),
		transport: world.transport,
		mutations: world.mutations,
	};
});
