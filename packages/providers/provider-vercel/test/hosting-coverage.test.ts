/**
 * WP14 (plan 0024) Vercel coverage: the traffic-profile audit, the I14
 * coverage document, typed refusals, the wire/CUE forms and resolver
 * telemetry. Resolver behavior itself is covered by resolvers.test.ts.
 */
import { fromJson, toJson } from "@bufbuild/protobuf";
import {
	matchTrafficRoutingOfferings,
	parseTrafficRoutingProviderProfile,
	ResolverError,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import { HostingCoverageSchema } from "../src/_generated/hosting_coverage_pb.js";
import {
	RESOLVER_OPERATIONS_METRIC,
	type ResolverMetricPoint,
	VERCEL_BLOB_PRODUCT_ID,
	VERCEL_EDGE_FUNCTION_PRODUCT_ID,
	VERCEL_HOSTING_COVERAGE,
	VERCEL_RESOLVED_PRODUCT_IDS,
	VERCEL_TRAFFIC_ROUTING_ABSENT,
	VERCEL_TRAFFIC_ROUTING_PROFILE,
	VERCEL_UNRESOLVED_PRODUCT_IDS,
	VERCEL_UNRESOLVED_PRODUCTS,
	vercelProductRefusal,
	vercelResolverRegistry,
} from "../src/index.js";
import { cueVet } from "./support/cue-vet.js";

const refuse = async () => {
	throw new Error("no live provider in this test");
};

describe("Vercel traffic routing profile (WP14 audit, I14)", () => {
	it("keeps the core vercel kind and parses unchanged at the core boundary", () => {
		expect(VERCEL_TRAFFIC_ROUTING_PROFILE.provider).toBe("vercel");
		expect(
			parseTrafficRoutingProviderProfile(
				JSON.parse(JSON.stringify(VERCEL_TRAFFIC_ROUTING_PROFILE)),
			),
		).toEqual(VERCEL_TRAFFIC_ROUTING_PROFILE);
	});
	it("realizes the edge canary through Rolling Releases and declares the other fourteen offerings absent", () => {
		expect(VERCEL_HOSTING_COVERAGE.traffic.offerings).toEqual([
			"edge.canary",
			"edge.path",
			"edge.header",
		]);
		expect(VERCEL_TRAFFIC_ROUTING_ABSENT).toHaveLength(14);
		expect(
			matchTrafficRoutingOfferings(VERCEL_TRAFFIC_ROUTING_PROFILE, {
				features: ["edge.canary"],
				negotiation: "require",
			}).kind,
		).toBe("full");
	});
	it("keeps the in-process router as a fallback, never as a native rung", () => {
		expect(VERCEL_TRAFFIC_ROUTING_PROFILE.fallbacks).toEqual([
			"inprocess.weighted",
		]);
		expect(VERCEL_HOSTING_COVERAGE.traffic.offerings).not.toContain(
			"inprocess.weighted",
		);
	});
});

describe("Vercel hosting coverage document (I14)", () => {
	it("resolves exactly the shipped registry's products", () => {
		const registry = vercelResolverRegistry({
			resolveCredential: refuse,
			teamId: "team_hobo",
		});
		expect(registry.list().map((entry) => entry.productId)).toEqual(
			VERCEL_HOSTING_COVERAGE.resolvedProductIds,
		);
		expect([...VERCEL_HOSTING_COVERAGE.resolvedProductIds]).toEqual(
			[...VERCEL_RESOLVED_PRODUCT_IDS].sort(),
		);
	});
	it("refuses every catalogued unresolved product with RESOLVER_PRODUCT_UNSUPPORTED and a remediation", () => {
		const ids = VERCEL_UNRESOLVED_PRODUCTS.map((entry) => entry.productId);
		for (const legacy of VERCEL_UNRESOLVED_PRODUCT_IDS)
			expect(ids).toContain(legacy);
		expect(ids).toContain(VERCEL_BLOB_PRODUCT_ID);
		expect(ids).toContain(VERCEL_EDGE_FUNCTION_PRODUCT_ID);
		for (const productId of ids) {
			const refusal = vercelProductRefusal(productId);
			expect(refusal).toBeInstanceOf(ResolverError);
			expect(refusal?.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
			expect(refusal?.message).toContain("Remediation:");
		}
		for (const productId of VERCEL_RESOLVED_PRODUCT_IDS)
			expect(vercelProductRefusal(productId)).toBeUndefined();
	});
	it("round-trips through the protobuf wire form", () => {
		const json = JSON.parse(JSON.stringify(VERCEL_HOSTING_COVERAGE));
		expect(
			toJson(HostingCoverageSchema, fromJson(HostingCoverageSchema, json), {
				alwaysEmitImplicit: true,
			}),
		).toEqual(json);
	});
	it("serializes to a record the CUE #HostingCoverage constraint accepts", () => {
		cueVet(
			"hosting_coverage.cue",
			"#HostingCoverage",
			JSON.stringify(VERCEL_HOSTING_COVERAGE),
		);
	});
});

describe("Vercel resolver telemetry", () => {
	it("emits a typed-outcome metric even when a call is refused", async () => {
		const points: ResolverMetricPoint[] = [];
		const registry = vercelResolverRegistry({
			resolveCredential: refuse,
			teamId: "team_hobo",
			metrics: {
				async metrics(batch) {
					points.push(...batch);
				},
			},
			nowMs: () => 1_000,
		});
		const resolver = registry.list()[0];
		if (!resolver) throw new Error("registry is empty");
		await expect(
			resolver.reconcile(
				{
					ref: {
						slot: "kv",
						productId: "vercel.other/v1",
						logicalId: "x",
					},
					desired: {},
					credentialRef: "vault://vercel/token",
				},
				refuse,
			),
		).rejects.toBeInstanceOf(ResolverError);
		expect(points[0]?.name).toBe(RESOLVER_OPERATIONS_METRIC);
		expect(points[0]?.attributes["hobo.provider.id"]).toBe("vercel");
		expect(points[0]?.attributes["hobo.resolver.outcome"]).toMatch(
			/^RESOLVER_/u,
		);
	});
});
