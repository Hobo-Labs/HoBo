/**
 * The provider-neutral I14 coverage and resolver telemetry module. Identical
 * in every WP13 provider package (see src/delivery-coverage.ts).
 */
import {
	offering,
	RESOLVER_CONTRACT,
	type ResolveRequest,
	ResolverError,
	type ResourceResolver,
	type TrafficRoutingProviderProfile,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	defineHostingCoverage,
	HOSTING_COVERAGE_CONTRACT,
	hostingProductRefusal,
	instrumentResolvers,
	PORTABLE_TRAFFIC_OFFERING_IDS,
	RESOLVER_DURATION_METRIC,
	RESOLVER_OPERATIONS_METRIC,
	type ResolverMetricPoint,
} from "../src/delivery-coverage.js";

const FLOOR: TrafficRoutingProviderProfile = {
	provider: "other",
	offerings: [offering("inprocess.weighted", { features: ["fallback-floor"] })],
	fallbacks: ["inprocess.weighted"],
};
const ALL_ABSENT = PORTABLE_TRAFFIC_OFFERING_IDS.filter(
	(id) => id !== "inprocess.weighted",
).map((offeringId) => ({ offeringId, reason: "not offered" }));

function coverage(
	overrides: Partial<Parameters<typeof defineHostingCoverage>[0]> = {},
) {
	return defineHostingCoverage({
		providerId: "example",
		resolvedProductIds: ["example.b/v1", "example.a/v1"],
		unresolved: [
			{
				productId: "example.z/v1",
				reason: "No API.",
				remediation: "Use a runbook.",
			},
		],
		profile: FLOOR,
		absent: ALL_ABSENT,
		...overrides,
	});
}

const request: ResolveRequest = {
	ref: { slot: "service", productId: "example.a/v1", logicalId: "app" },
	desired: {},
	credentialRef: "vault://example/token",
};
function resolver(fail?: Error): ResourceResolver {
	return {
		providerId: "example",
		productId: "example.a/v1",
		async reconcile() {
			if (fail) throw fail;
			return {
				contract: RESOLVER_CONTRACT,
				action: "noop",
				physicalId: "physical",
				outputs: {},
				diagnostics: [],
			};
		},
		async delete() {},
		async read() {
			return undefined;
		},
	};
}

describe("I14 hosting coverage document", () => {
	it("is frozen, contract-stamped and id-sorted", () => {
		const doc = coverage();
		expect(doc.contract).toBe(HOSTING_COVERAGE_CONTRACT);
		expect(doc.resolvedProductIds).toEqual(["example.a/v1", "example.b/v1"]);
		expect(Object.isFrozen(doc)).toBe(true);
		expect(Object.isFrozen(doc.traffic.absent)).toBe(true);
		expect(doc.traffic.offerings).toEqual(["inprocess.weighted"]);
	});
	it("refuses a product that is both resolved and refused", () => {
		expect(() =>
			coverage({
				unresolved: [
					{ productId: "example.a/v1", reason: "x", remediation: "y" },
				],
			}),
		).toThrow(/both resolved and refused/u);
	});
	it("refuses a refusal without remediation", () => {
		expect(() =>
			coverage({
				unresolved: [
					{ productId: "example.z/v1", reason: "x", remediation: " " },
				],
			}),
		).toThrow(/reason and a remediation/u);
	});
	it("refuses an offering that is neither present nor declared absent", () => {
		expect(() => coverage({ absent: ALL_ABSENT.slice(1) })).toThrow(
			/present or declared absent/u,
		);
	});
	it("refuses an offering declared both present and absent", () => {
		expect(() =>
			coverage({
				absent: [
					...ALL_ABSENT,
					{ offeringId: "inprocess.weighted", reason: "contradiction" },
				],
			}),
		).toThrow(/both present and absent/u);
	});
	it("refuses a fallback the provider does not realize", () => {
		expect(() =>
			coverage({ profile: { ...FLOOR, fallbacks: ["dns.weighted"] } }),
		).toThrow(/fallback dns.weighted/u);
	});
	it("refuses a profile that fails the core parse boundary", () => {
		expect(() =>
			coverage({
				profile: {
					provider: "other",
					offerings: [
						offering("inprocess.weighted"),
						offering("inprocess.weighted"),
					],
					fallbacks: [],
				},
			}),
		).toThrow();
	});
});

describe("typed product refusal (RESOLVER_PRODUCT_UNSUPPORTED)", () => {
	it("names the reason and remediation for a catalogued unresolved product", () => {
		const refusal = hostingProductRefusal(coverage(), "example.z/v1");
		expect(refusal).toBeInstanceOf(ResolverError);
		expect(refusal?.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(refusal?.message).toBe(
			"example.z/v1: No API. Remediation: Use a runbook.",
		);
	});
	it("names the WASM component escape for an uncatalogued product", () => {
		expect(
			hostingProductRefusal(coverage(), "other.thing/v1")?.message,
		).toMatch(/hobo:resolver WASM component/u);
	});
	it("returns undefined for a resolved product", () => {
		expect(hostingProductRefusal(coverage(), "example.a/v1")).toBeUndefined();
	});
});

describe("resolver telemetry", () => {
	it("returns resolvers unchanged without a sink", () => {
		const list = [resolver()];
		expect(instrumentResolvers(list, {})).toBe(list);
	});
	it("refuses a sink without an injected clock (I8)", () => {
		expect(() =>
			instrumentResolvers([resolver()], { metrics: { async metrics() {} } }),
		).toThrow(/nowMs/u);
	});
	it("emits operation counter and duration with outcome and action", async () => {
		const points: ResolverMetricPoint[] = [];
		let clock = 100;
		const [wrapped] = instrumentResolvers([resolver()], {
			metrics: {
				async metrics(batch) {
					points.push(...batch);
				},
			},
			nowMs: () => {
				clock += 5;
				return clock;
			},
		});
		await wrapped?.reconcile(request, async () => {
			throw new Error("unused");
		});
		expect(points.map((point) => point.name)).toEqual([
			RESOLVER_OPERATIONS_METRIC,
			RESOLVER_DURATION_METRIC,
		]);
		expect(points[0]).toMatchObject({
			kind: "counter",
			value: 1,
			attributes: {
				"hobo.provider.id": "example",
				"hobo.resolver.product_id": "example.a/v1",
				"hobo.resolver.operation": "reconcile",
				"hobo.resolver.outcome": "ok",
				"hobo.resolver.action": "noop",
			},
		});
		expect(points[1]).toMatchObject({
			kind: "histogram",
			value: 5,
			unit: "ms",
		});
	});
	it("records the typed failure code and rethrows the original error", async () => {
		const points: ResolverMetricPoint[] = [];
		const failure = new ResolverError("RESOLVER_PROVIDER_REJECTED", "no");
		const [wrapped] = instrumentResolvers([resolver(failure)], {
			metrics: {
				async metrics(batch) {
					points.push(...batch);
				},
			},
			nowMs: () => 1,
		});
		await expect(
			wrapped?.reconcile(request, async () => {
				throw new Error("unused");
			}),
		).rejects.toBe(failure);
		expect(points[0]?.attributes["hobo.resolver.outcome"]).toBe(
			"RESOLVER_PROVIDER_REJECTED",
		);
	});
	it("a failing sink never changes the resolver outcome", async () => {
		const [wrapped] = instrumentResolvers([resolver()], {
			metrics: {
				async metrics() {
					throw new Error("collector down");
				},
			},
			nowMs: () => 1,
		});
		const result = await wrapped?.reconcile(request, async () => {
			throw new Error("unused");
		});
		expect(result?.action).toBe("noop");
		expect(
			await wrapped?.read?.(request, async () => {
				throw new Error("unused");
			}),
		).toBeUndefined();
	});
});
