/**
 * WP14 (plan 0024) Browser WASM coverage: I14 realization path (an
 * observation-only guest resolver over the host origin) + traffic profile,
 * typed refusals, telemetry and resolver conformance on pact-recorded fixtures.
 */
import { readFileSync } from "node:fs";
import {
	type HttpTransport,
	matchTrafficRoutingOfferings,
	parseTrafficRoutingProviderProfile,
	type ResolveRequest,
	ResolverError,
	type TransportRequest,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	BROWSER_WASM_GUEST_PRODUCT_ID,
	BROWSER_WASM_HOSTING_COVERAGE,
	BROWSER_WASM_RESOLVED_PRODUCT_IDS,
	BROWSER_WASM_TRAFFIC_ROUTING_ABSENT,
	BROWSER_WASM_TRAFFIC_ROUTING_PROFILE,
	BROWSER_WASM_UNRESOLVED_PRODUCTS,
	browserWasmProductRefusal,
	browserWasmResolverRegistry,
	RESOLVER_DURATION_METRIC,
	RESOLVER_OPERATIONS_METRIC,
	type ResolverMetricPoint,
} from "../src/index.js";
import { cueVet } from "./support/cue-vet.js";
import { describeResolverConformance } from "./support/resolver-conformance.js";

interface PactInteraction {
	readonly description: string;
	readonly request: { readonly path: string };
	readonly response: { readonly status: number; readonly body?: unknown };
}
// SAFETY: checked-in pact fixture with the PactInteraction shape.
const pact = JSON.parse(
	readFileSync(
		new URL(
			"../contracts/provider-browser-wasm-host-origin.pact.json",
			import.meta.url,
		),
		"utf8",
	),
) as { readonly interactions: readonly PactInteraction[] };
function recorded(description: string): PactInteraction {
	const found = pact.interactions.find((entry) =>
		entry.description.startsWith(description),
	);
	if (!found) throw new Error(`pact has no interaction ${description}`);
	return found;
}

const ORIGIN = "https://try-site.browser-wasm.hobo.localhost";
const CAPABILITIES = recorded(
	"report a cross-origin isolated context with durable storage",
);
const SMALL_CONTEXT = recorded("report a private-mode context");
const MANIFEST = recorded("serve the guest manifest");
const NOT_FOUND = recorded("report GUEST_NOT_FOUND");
const DIGEST =
	"sha256:24eaf3439a60c96764c4f2c92a0a81b52bd4fe5d5b91f090184a0f6486b1bf29";

function host(
	options: {
		readonly manifest?: PactInteraction;
		readonly capabilities?: PactInteraction;
	} = {},
) {
	const calls: TransportRequest[] = [];
	const transport: HttpTransport = async (call) => {
		calls.push(call);
		const path = new URL(call.url).pathname;
		const interaction =
			path === "/_hobo/host/capabilities"
				? (options.capabilities ?? CAPABILITIES)
				: path === "/_hobo/guests/try-site/manifest.json"
					? (options.manifest ?? MANIFEST)
					: NOT_FOUND;
		return {
			status: interaction.response.status,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(interaction.response.body ?? null),
		};
	};
	return {
		transport,
		calls,
		mutations: () => calls.filter((call) => call.method !== "GET").length,
	};
}

function request(
	overrides: Partial<ResolveRequest["desired"]> = {},
	physicalId?: string,
): ResolveRequest {
	return {
		ref: {
			slot: "service",
			productId: BROWSER_WASM_GUEST_PRODUCT_ID,
			logicalId: "try-site",
			...(physicalId === undefined ? {} : { physicalId }),
		},
		desired: {
			origin: ORIGIN,
			guestId: "try-site",
			artifactDigest: DIGEST,
			...overrides,
		},
		credentialRef: "none://browser-wasm/host-origin",
	};
}
const PHYSICAL = `${ORIGIN}/_hobo/guests/try-site`;

function resolver() {
	const found = browserWasmResolverRegistry({}).get(
		BROWSER_WASM_GUEST_PRODUCT_ID,
	);
	if (!found) throw new Error("guest resolver missing");
	return found;
}

describe("Browser WASM traffic routing profile (I14, ADR-0144)", () => {
	it("kind is 'other' because the core union has no browser-wasm member", () => {
		expect(BROWSER_WASM_TRAFFIC_ROUTING_PROFILE.provider).toBe("other");
		expect(
			parseTrafficRoutingProviderProfile(
				JSON.parse(JSON.stringify(BROWSER_WASM_TRAFFIC_ROUTING_PROFILE)),
			),
		).toEqual(BROWSER_WASM_TRAFFIC_ROUTING_PROFILE);
	});
	it("declares only host-page in-process selection; every other offering is absent with a reason", () => {
		expect(BROWSER_WASM_HOSTING_COVERAGE.traffic.offerings).toEqual([
			"inprocess.weighted",
		]);
		expect(BROWSER_WASM_TRAFFIC_ROUTING_ABSENT).toHaveLength(16);
	});
	it("a required weighted load balancer is refused, never faked (I6)", () => {
		expect(
			matchTrafficRoutingOfferings(BROWSER_WASM_TRAFFIC_ROUTING_PROFILE, {
				features: ["lb.weighted"],
				negotiation: "require",
			}).kind,
		).toBe("none");
	});
});

describe("Browser WASM hosting coverage document (I14)", () => {
	it("resolves the guest and refuses the in-browser kv and queue with remediation", () => {
		expect(BROWSER_WASM_RESOLVED_PRODUCT_IDS).toEqual([
			BROWSER_WASM_GUEST_PRODUCT_ID,
		]);
		expect(
			BROWSER_WASM_UNRESOLVED_PRODUCTS.map((entry) => entry.productId),
		).toEqual(["browser-wasm.kv/v1", "browser-wasm.queue/v1"]);
		const refusal = browserWasmProductRefusal("browser-wasm.queue/v1");
		expect(refusal).toBeInstanceOf(ResolverError);
		expect(refusal?.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(refusal?.message).toContain("Remediation:");
	});
	it("serializes to a record the CUE #HostingCoverage constraint accepts", () => {
		cueVet(
			"hosting_coverage.cue",
			"#HostingCoverage",
			JSON.stringify(BROWSER_WASM_HOSTING_COVERAGE),
		);
	});
});

describeResolverConformance("browser-wasm.guest/v1", () => {
	const fx = host();
	return {
		registry: browserWasmResolverRegistry({}),
		coverage: BROWSER_WASM_HOSTING_COVERAGE,
		request: request({}, PHYSICAL),
		transport: fx.transport,
		mutations: fx.mutations,
	};
});

describe("Browser WASM guest resolver (observation only)", () => {
	it("reads the host capabilities and the guest manifest, and never mutates the origin", async () => {
		const fx = host();
		const outcome = await resolver().reconcile(request(), fx.transport);
		expect(outcome.action).toBe("adopt");
		expect(outcome.physicalId).toBe(PHYSICAL);
		expect(outcome.outputs.ready).toBe(true);
		expect(outcome.outputs.artifactDigest).toBe(DIGEST);
		expect(fx.calls.map((call) => new URL(call.url).pathname)).toEqual([
			"/_hobo/host/capabilities",
			"/_hobo/guests/try-site/manifest.json",
		]);
		expect(fx.mutations()).toBe(0);
	});

	it("is pending, not failed, while the host page has not published the guest yet", async () => {
		const fx = host({ manifest: NOT_FOUND });
		const outcome = await resolver().reconcile(request(), fx.transport);
		expect(outcome.outputs.ready).toBe(false);
		expect(outcome.outputs.lifecycleStatus).toBe("pending");
		expect(outcome.diagnostics.join(" ")).toContain("publish");
		expect(await resolver().read?.(request(), fx.transport)).toBeUndefined();
	});

	it("is pending while the origin publishes another digest (I1: promote, never rebuild)", async () => {
		const fx = host();
		const outcome = await resolver().reconcile(
			request({ artifactDigest: `sha256:${"c".repeat(64)}` }),
			fx.transport,
		);
		expect(outcome.outputs.ready).toBe(false);
		expect(outcome.diagnostics.join(" ")).toContain("another digest");
	});

	it("is not ready when the host context cannot hold the guest's memory or storage", async () => {
		const fx = host({ capabilities: SMALL_CONTEXT });
		const outcome = await resolver().reconcile(request(), fx.transport);
		expect(outcome.outputs.ready).toBe(false);
		expect(outcome.diagnostics.join(" ")).toContain("persistence");
	});

	it("refuses a non-https origin and an origin with a path", async () => {
		const fx = host();
		for (const origin of [
			"http://try-site.example",
			`${ORIGIN}/app`,
			"https://user@try-site.example",
		])
			await expect(
				resolver().reconcile(request({ origin }), fx.transport),
			).rejects.toMatchObject({ code: "RESOLVER_PROVIDER_REJECTED" });
		expect(fx.calls).toHaveLength(0);
	});

	it("maps a changed host contract to RESOLVER_OUTPUT_UNPARSEABLE", async () => {
		const fx = host({
			manifest: {
				...MANIFEST,
				response: { status: 200, body: { schemaVersion: "other/v9" } },
			},
		});
		await expect(
			resolver().reconcile(request(), fx.transport),
		).rejects.toMatchObject({ code: "RESOLVER_OUTPUT_UNPARSEABLE" });
	});

	it("never resolves a credential: the host origin has nothing to authenticate to", async () => {
		const fx = host();
		await resolver().reconcile(request(), fx.transport);
		for (const call of fx.calls) {
			expect(call.headers.authorization).toBeUndefined();
			expect(call.url).not.toContain("none://");
		}
	});

	it("delete confirms the guest is no longer published, and refuses while it still is", async () => {
		await expect(
			resolver().delete(request({}, PHYSICAL), host().transport),
		).rejects.toThrow(/still publishes/u);
		await expect(
			resolver().delete(
				request({}, PHYSICAL),
				host({ manifest: NOT_FOUND }).transport,
			),
		).resolves.toBeUndefined();
	});

	it("refuses another product id and undeclared desired keys", async () => {
		const fx = host();
		await expect(
			resolver().reconcile(
				{
					...request(),
					ref: { ...request().ref, productId: "browser-wasm.kv/v1" },
				},
				fx.transport,
			),
		).rejects.toMatchObject({ code: "RESOLVER_PRODUCT_UNSUPPORTED" });
		await expect(
			resolver().reconcile(request({ replicas: 2 }), fx.transport),
		).rejects.toMatchObject({ code: "RESOLVER_PROVIDER_REJECTED" });
	});
});

describe("Browser WASM resolver telemetry", () => {
	it("emits operation and duration metrics with an injected clock", async () => {
		const points: ResolverMetricPoint[] = [];
		let now = 0;
		const registry = browserWasmResolverRegistry({
			metrics: {
				async metrics(batch) {
					points.push(...batch);
				},
			},
			nowMs: () => (now += 3),
		});
		await registry
			.get(BROWSER_WASM_GUEST_PRODUCT_ID)
			?.reconcile(request(), host().transport);
		expect(points.map((point) => point.name)).toEqual([
			RESOLVER_OPERATIONS_METRIC,
			RESOLVER_DURATION_METRIC,
		]);
		expect(points[0]?.attributes["hobo.provider.id"]).toBe("browser-wasm");
	});
});
