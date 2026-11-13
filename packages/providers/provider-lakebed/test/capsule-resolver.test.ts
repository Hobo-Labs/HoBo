/**
 * WP14 (plan 0024) Lakebed coverage: I14 realization path (capsule resolver
 * over the lakebed-deploy driver seam) + traffic profile, typed refusals,
 * telemetry and resolver conformance on fixtures.
 */
import { readFileSync } from "node:fs";
import {
	type HttpTransport,
	matchTrafficRoutingOfferings,
	parseTrafficRoutingProviderProfile,
	type ResolveRequest,
	ResolverError,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createLakebedResolvers,
	type DriverProgram,
	LAKEBED_CAPSULE_PRODUCT_ID,
	LAKEBED_HOSTING_COVERAGE,
	LAKEBED_RESOLVED_PRODUCT_IDS,
	LAKEBED_TRAFFIC_ROUTING_ABSENT,
	LAKEBED_TRAFFIC_ROUTING_PROFILE,
	LAKEBED_UNRESOLVED_PRODUCTS,
	type LakebedCapsuleRecord,
	type LakebedDeployHost,
	lakebedProductRefusal,
	lakebedResolverRegistry,
	RESOLVER_DURATION_METRIC,
	RESOLVER_OPERATIONS_METRIC,
	type ResolverMetricPoint,
} from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";
import { cueVet } from "./support/cue-vet.js";
import { describeResolverConformance } from "./support/resolver-conformance.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const TOKEN = "lakebed-deploy-token-material";
const CREDENTIAL_REF = "vault://lakebed/deploy";
const URL_OK = "https://shop-prod.lakebed.app";

function world(
	initial?: LakebedCapsuleRecord,
	options: { readonly probeStatus?: number } = {},
) {
	let record = initial;
	const deployed: { program: DriverProgram; token: string }[] = [];
	const retired: string[] = [];
	const tokensSeen: string[] = [];
	const host: LakebedDeployHost = {
		async deploy(input) {
			tokensSeen.push(input.token);
			deployed.push({ program: input.program, token: input.token });
			record = {
				state: "live",
				deploymentId: input.program.deploymentId,
				url: URL_OK,
				artifactDigest: input.artifactDigest,
			};
			return { deploymentId: input.program.deploymentId };
		},
		async describe(input) {
			tokensSeen.push(input.token);
			return record;
		},
		async retire(input) {
			tokensSeen.push(input.token);
			retired.push(input.deploymentId);
			record = { state: "retired", deploymentId: input.deploymentId };
		},
	};
	const probes: string[] = [];
	const transport: HttpTransport = async (call) => {
		probes.push(call.url);
		return { status: options.probeStatus ?? 200, headers: {}, body: "ok" };
	};
	return {
		host,
		transport,
		deployed,
		retired,
		probes,
		tokensSeen,
		mutations: () => deployed.length + retired.length,
		set(next: LakebedCapsuleRecord | undefined) {
			record = next;
		},
	};
}

const resolveCredential = async (ref: string) => {
	if (ref !== CREDENTIAL_REF) throw new Error("unexpected credential ref");
	return TOKEN;
};

function request(
	overrides: Partial<ResolveRequest["desired"]> = {},
	physicalId?: string,
): ResolveRequest {
	const ref = {
		slot: "service" as const,
		productId: LAKEBED_CAPSULE_PRODUCT_ID,
		logicalId: "shop",
	};
	return {
		ref: physicalId === undefined ? ref : { ...ref, physicalId },
		desired: {
			deploymentId: "shop-prod",
			artifactDigest: DIGEST,
			...overrides,
		},
		credentialRef: CREDENTIAL_REF,
	};
}

const LIVE: LakebedCapsuleRecord = {
	state: "live",
	deploymentId: "shop-prod",
	url: URL_OK,
	artifactDigest: DIGEST,
};

function resolver(fx: ReturnType<typeof world>) {
	const found = lakebedResolverRegistry({
		host: fx.host,
		resolveCredential,
	}).get(LAKEBED_CAPSULE_PRODUCT_ID);
	if (!found) throw new Error("capsule resolver missing");
	return found;
}

describe("Lakebed traffic routing profile (I14, ADR-0144)", () => {
	it("keeps the core lakebed kind and parses unchanged at the core boundary", () => {
		expect(LAKEBED_TRAFFIC_ROUTING_PROFILE.provider).toBe("lakebed");
		expect(
			parseTrafficRoutingProviderProfile(
				JSON.parse(JSON.stringify(LAKEBED_TRAFFIC_ROUTING_PROFILE)),
			),
		).toEqual(LAKEBED_TRAFFIC_ROUTING_PROFILE);
	});
	it("declares in-process weights and the deploy-time route bind; every other offering is absent with a reason", () => {
		expect(LAKEBED_HOSTING_COVERAGE.traffic.offerings).toEqual([
			"inprocess.weighted",
			"driver.route-bind",
		]);
		expect(LAKEBED_TRAFFIC_ROUTING_ABSENT).toHaveLength(15);
		for (const entry of LAKEBED_TRAFFIC_ROUTING_ABSENT)
			expect(entry.reason.trim()).not.toBe("");
	});
	it("a required edge canary is refused, never faked (I6)", () => {
		expect(
			matchTrafficRoutingOfferings(LAKEBED_TRAFFIC_ROUTING_PROFILE, {
				features: ["edge.canary"],
				negotiation: "require",
			}).kind,
		).toBe("none");
	});
});

describe("Lakebed hosting coverage document (I14)", () => {
	it("resolves the capsule and refuses every other catalogued product with a remediation", () => {
		expect(LAKEBED_RESOLVED_PRODUCT_IDS).toEqual([LAKEBED_CAPSULE_PRODUCT_ID]);
		expect(LAKEBED_UNRESOLVED_PRODUCTS.map((entry) => entry.productId)).toEqual(
			[
				"lakebed.capsule-kv/v1",
				"lakebed.file-store/v1",
				"lakebed.reactive-db/v1",
				"lakebed.traffic-route/v1",
			],
		);
		const refusal = lakebedProductRefusal("lakebed.capsule-kv/v1");
		expect(refusal).toBeInstanceOf(ResolverError);
		expect(refusal?.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(refusal?.message).toContain("Remediation:");
		expect(lakebedProductRefusal(LAKEBED_CAPSULE_PRODUCT_ID)).toBeUndefined();
	});
	it("serializes to a record the CUE #HostingCoverage constraint accepts", () => {
		cueVet(
			"hosting_coverage.cue",
			"#HostingCoverage",
			JSON.stringify(LAKEBED_HOSTING_COVERAGE),
		);
	});
	it("constrains the driver host's capsule record in CUE as the resolver parses it", () => {
		cueVet(
			"hosting_coverage.cue",
			"#LakebedCapsuleRecord",
			JSON.stringify(LIVE),
		);
		expect(() =>
			cueVet(
				"hosting_coverage.cue",
				"#LakebedCapsuleRecord",
				JSON.stringify({ ...LIVE, url: "https://shop.example.com" }),
			),
		).toThrow();
	});
	it("is deep-frozen", () => {
		expect(Object.isFrozen(LAKEBED_HOSTING_COVERAGE)).toBe(true);
		expect(Object.isFrozen(LAKEBED_HOSTING_COVERAGE.traffic.absent)).toBe(true);
	});
});

describeResolverConformance("lakebed.capsule/v1", () => {
	const fx = world(LIVE);
	return {
		registry: lakebedResolverRegistry({ host: fx.host, resolveCredential }),
		coverage: LAKEBED_HOSTING_COVERAGE,
		request: request({}, "shop-prod"),
		transport: fx.transport,
		mutations: fx.mutations,
		secret: TOKEN,
	};
});

describe("Lakebed capsule resolver", () => {
	it("creates a capsule through one lakebed-deploy driver program and observes readiness", async () => {
		const fx = world();
		const outcome = await resolver(fx).reconcile(request(), fx.transport);
		expect(outcome.action).toBe("create");
		expect(outcome.physicalId).toBe("shop-prod");
		expect(outcome.outputs.ready).toBe(true);
		expect(outcome.outputs.servingEndpoint).toBe(URL_OK);
		expect(fx.deployed).toHaveLength(1);
		const program = fx.deployed[0]?.program;
		expect(program?.driver).toBe("lakebed-deploy");
		expect(program?.resources.map((entry) => entry.type)).toEqual([
			"lakebed:capsule",
		]);
		expect(fx.probes).toEqual([URL_OK]);
	});

	it("realizes declared kv, file-store and reactive-db resources inside the same capsule program", async () => {
		const fx = world();
		await resolver(fx).reconcile(
			request({
				resources: [
					{ name: "web", port: "compute" },
					{ name: "cart", port: "kv" },
					{ name: "uploads", port: "objectStore" },
					{ name: "orders", port: "database" },
				],
			}),
			fx.transport,
		);
		expect(
			fx.deployed[0]?.program.resources.map((entry) => entry.type),
		).toEqual([
			"lakebed:capsule",
			"lakebed:capsule-kv",
			"lakebed:file-store",
			"lakebed:reactive-db",
		]);
	});

	it("refuses a port the Capsule runtime cannot host (I6)", async () => {
		const fx = world();
		await expect(
			resolver(fx).reconcile(
				request({ resources: [{ name: "jobs", port: "queue" }] }),
				fx.transport,
			),
		).rejects.toMatchObject({ code: "RESOLVER_PROVIDER_REJECTED" });
		expect(fx.deployed).toHaveLength(0);
	});

	it("hands the deploy token to the driver host only, never to outcomes or errors (I9)", async () => {
		const fx = world();
		const outcome = await resolver(fx).reconcile(request(), fx.transport);
		expect(fx.tokensSeen.every((token) => token === TOKEN)).toBe(true);
		expect(JSON.stringify(outcome)).not.toContain(TOKEN);
		fx.set({ ...LIVE, url: "https://evil.example.com" });
		const failure = await resolver(fx)
			.read?.(request({}, "shop-prod"), fx.transport)
			.then(
				() => undefined,
				(error: Error) => error,
			);
		expect(failure).toBeInstanceOf(ResolverError);
		expect(failure?.message ?? "").not.toContain(TOKEN);
	});

	it("refuses an unresolvable credential with RESOLVER_CREDENTIAL_MISSING", async () => {
		const fx = world();
		const registry = lakebedResolverRegistry({
			host: fx.host,
			resolveCredential: async () => {
				throw new Error("vault sealed");
			},
		});
		await expect(
			registry
				.get(LAKEBED_CAPSULE_PRODUCT_ID)
				?.reconcile(request(), fx.transport),
		).rejects.toMatchObject({ code: "RESOLVER_CREDENTIAL_MISSING" });
	});

	it("reports not-ready when the capsule probe fails: readiness is observed, never assumed (I5)", async () => {
		const fx = world(LIVE, { probeStatus: 503 });
		const outcome = await resolver(fx).reconcile(
			request({}, "shop-prod"),
			fx.transport,
		);
		expect(outcome.action).toBe("noop");
		expect(outcome.outputs.ready).toBe(false);
		expect(outcome.outputs.servingEndpoint).toBeUndefined();
		expect(outcome.diagnostics.join(" ")).toContain("HTTP 503");
	});

	it("refuses an in-place artifact change; a new version goes to a new deployment id", async () => {
		const fx = world(LIVE);
		await expect(
			resolver(fx).reconcile(
				request({ artifactDigest: OTHER_DIGEST }, "shop-prod"),
				fx.transport,
			),
		).rejects.toThrow(/new deployment id/u);
		expect(fx.mutations()).toBe(0);
	});

	it("never resurrects a retired capsule", async () => {
		const fx = world({ state: "retired", deploymentId: "shop-prod" });
		await expect(
			resolver(fx).reconcile(request({}, "shop-prod"), fx.transport),
		).rejects.toMatchObject({ code: "RESOLVER_PROVIDER_REJECTED" });
	});

	it("refuses a host answer with a non-Lakebed endpoint", async () => {
		const fx = world({ ...LIVE, url: "http://shop.lakebed.app:8080" });
		await expect(
			resolver(fx).read?.(request({}, "shop-prod"), fx.transport),
		).rejects.toMatchObject({ code: "RESOLVER_OUTPUT_UNPARSEABLE" });
	});

	it("deletes by retiring and confirms the retirement by observation", async () => {
		const fx = world(LIVE);
		await resolver(fx).delete(request({}, "shop-prod"), fx.transport);
		expect(fx.retired).toEqual(["shop-prod"]);
		const read = await resolver(fx).read?.(
			request({}, "shop-prod"),
			fx.transport,
		);
		expect(read?.outputs.retirementConfirmed).toBe(true);
	});

	it("refuses a delete the host does not confirm", async () => {
		const fx = world(LIVE);
		const stubborn: LakebedDeployHost = {
			...fx.host,
			async retire() {},
		};
		const registry = lakebedResolverRegistry({
			host: stubborn,
			resolveCredential,
		});
		await expect(
			registry
				.get(LAKEBED_CAPSULE_PRODUCT_ID)
				?.delete(request({}, "shop-prod"), fx.transport),
		).rejects.toThrow(/not confirmed/u);
	});

	it("refuses another product id and undeclared desired keys", async () => {
		const fx = world();
		const capsule = resolver(fx);
		await expect(
			capsule.reconcile(
				{
					...request(),
					ref: { ...request().ref, productId: "lakebed.capsule-kv/v1" },
				},
				fx.transport,
			),
		).rejects.toMatchObject({ code: "RESOLVER_PRODUCT_UNSUPPORTED" });
		await expect(
			capsule.reconcile(request({ replicas: 3 }), fx.transport),
		).rejects.toMatchObject({ code: "RESOLVER_PROVIDER_REJECTED" });
	});

	it("refuses construction without a real driver host", () => {
		expect(() =>
			createLakebedResolvers({
				// SAFETY: deliberately malformed host to exercise the guard.
				host: {} as LakebedDeployHost,
				resolveCredential,
			}),
		).toThrow(ResolverError);
	});
});

describe("Lakebed resolver telemetry", () => {
	it("emits operation and duration metrics with an injected clock", async () => {
		const fx = world(LIVE);
		const points: ResolverMetricPoint[] = [];
		let now = 1_000;
		const registry = lakebedResolverRegistry({
			host: fx.host,
			resolveCredential,
			metrics: {
				async metrics(batch) {
					points.push(...batch);
				},
			},
			nowMs: () => (now += 5),
		});
		await registry
			.get(LAKEBED_CAPSULE_PRODUCT_ID)
			?.reconcile(request({}, "shop-prod"), fx.transport);
		expect(points.map((point) => point.name)).toEqual([
			RESOLVER_OPERATIONS_METRIC,
			RESOLVER_DURATION_METRIC,
		]);
		expect(points[0]?.attributes["hobo.provider.id"]).toBe("lakebed");
		expect(points[0]?.attributes["hobo.resolver.action"]).toBe("noop");
	});
	it("refuses a metric sink without an injected clock (I8)", () => {
		const fx = world();
		expect(() =>
			lakebedResolverRegistry({
				host: fx.host,
				resolveCredential,
				metrics: { metrics: async () => {} },
			}),
		).toThrow(ResolverError);
	});
});

interface PactInteraction {
	readonly providerState: string;
	readonly request: {
		readonly path: string;
		readonly body: JsonObject;
	};
	readonly response: { readonly body: JsonValue };
}

describe("PACT: capsule resolver and lakebed-deploy driver host", () => {
	// SAFETY: the pact file is a checked-in fixture with the PactInteraction shape.
	const pact = JSON.parse(
		readFileSync(
			new URL(
				"../contracts/provider-lakebed-deploy-host.pact.json",
				import.meta.url,
			),
			"utf8",
		),
	) as { readonly interactions: readonly PactInteraction[] };
	function interaction(path: string, state: string): PactInteraction {
		const found = pact.interactions.find(
			(entry) => entry.request.path === path && entry.providerState === state,
		);
		if (!found) throw new Error(`pact has no ${path} for ${state}`);
		return found;
	}

	it("drives create, describe and retire exactly as the recorded interactions", async () => {
		let state = "Lakebed has never seen shop-prod";
		const host: LakebedDeployHost = {
			async deploy(input) {
				const recorded = interaction("/deploy", state);
				expect(input.artifactDigest).toBe(recorded.request.body.artifactDigest);
				// SAFETY: the recorded /deploy body carries the program object.
				const program = recorded.request.body.program as JsonObject;
				expect(input.program).toMatchObject(program);
				state = "shop-prod is live";
				// SAFETY: recorded pact response for /deploy.
				return recorded.response.body as { deploymentId: string };
			},
			async describe(input) {
				const recorded = interaction("/describe", state);
				expect(input).toMatchObject(recorded.request.body);
				// SAFETY: recorded pact response; the resolver parses it.
				return (recorded.response.body ?? undefined) as
					| LakebedCapsuleRecord
					| undefined;
			},
			async retire(input) {
				const recorded = interaction("/retire", state);
				expect(input).toMatchObject(recorded.request.body);
				state = "shop-prod was retired";
			},
		};
		const capsule = lakebedResolverRegistry({
			host,
			resolveCredential,
		}).get(LAKEBED_CAPSULE_PRODUCT_ID);
		const fx = world();
		const created = await capsule?.reconcile(request(), fx.transport);
		expect(created?.action).toBe("create");
		await capsule?.delete(request({}, "shop-prod"), fx.transport);
		const read = await capsule?.read?.(request({}, "shop-prod"), fx.transport);
		expect(read?.outputs.lifecycleStatus).toBe("absent");
	});
});
