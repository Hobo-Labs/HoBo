/**
 * WP14 (plan 0024) Netlify coverage: the missing traffic profile, the I14
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
	NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID,
	NETLIFY_FUNCTIONS_PRODUCT_ID,
	NETLIFY_HOSTING_COVERAGE,
	NETLIFY_RESOLVED_PRODUCT_IDS,
	NETLIFY_TRAFFIC_ROUTING_ABSENT,
	NETLIFY_TRAFFIC_ROUTING_PROFILE,
	NETLIFY_UNRESOLVED_PRODUCTS,
	netlifyProductRefusal,
	netlifyResolverRegistry,
	RESOLVER_OPERATIONS_METRIC,
	type ResolverMetricPoint,
} from "../src/index.js";
import { cueVet } from "./support/cue-vet.js";

const refuse = async () => {
	throw new Error("no live provider in this test");
};
const options = {
	accountId: "account",
	accountSlug: "team",
	resolveCredential: refuse,
};

describe("Netlify traffic routing profile (WP14, I14)", () => {
	it("kind is 'other' because the core union has no netlify member", () => {
		expect(NETLIFY_TRAFFIC_ROUTING_PROFILE.provider).toBe("other");
		expect(
			parseTrafficRoutingProviderProfile(
				JSON.parse(JSON.stringify(NETLIFY_TRAFFIC_ROUTING_PROFILE)),
			),
		).toEqual(NETLIFY_TRAFFIC_ROUTING_PROFILE);
	});
	it("realizes only in-process weights between deploy permalinks; the other sixteen are absent", () => {
		expect(NETLIFY_HOSTING_COVERAGE.traffic.offerings).toEqual([
			"inprocess.weighted",
		]);
		expect(NETLIFY_TRAFFIC_ROUTING_ABSENT).toHaveLength(16);
	});
	it("a required edge canary is refused, never faked with branch split testing (I6)", () => {
		expect(
			matchTrafficRoutingOfferings(NETLIFY_TRAFFIC_ROUTING_PROFILE, {
				features: ["edge.canary"],
				negotiation: "require",
			}).kind,
		).toBe("none");
	});
});

describe("Netlify hosting coverage document (I14)", () => {
	it("resolves exactly the shipped registry's products", () => {
		expect(
			netlifyResolverRegistry(options)
				.list()
				.map((entry) => entry.productId),
		).toEqual(NETLIFY_HOSTING_COVERAGE.resolvedProductIds);
		expect([...NETLIFY_HOSTING_COVERAGE.resolvedProductIds]).toEqual(
			[...NETLIFY_RESOLVED_PRODUCT_IDS].sort(),
		);
	});
	it("refuses the anonymous site and functions with RESOLVER_PRODUCT_UNSUPPORTED and a remediation", () => {
		expect(NETLIFY_UNRESOLVED_PRODUCTS.map((entry) => entry.productId)).toEqual(
			[
				NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID,
				NETLIFY_FUNCTIONS_PRODUCT_ID,
			],
		);
		for (const entry of NETLIFY_UNRESOLVED_PRODUCTS) {
			const refusal = netlifyProductRefusal(entry.productId);
			expect(refusal).toBeInstanceOf(ResolverError);
			expect(refusal?.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
			expect(refusal?.message).toContain("Remediation:");
		}
		for (const productId of NETLIFY_RESOLVED_PRODUCT_IDS)
			expect(netlifyProductRefusal(productId)).toBeUndefined();
	});
	it("round-trips through the protobuf wire form", () => {
		const json = JSON.parse(JSON.stringify(NETLIFY_HOSTING_COVERAGE));
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
			JSON.stringify(NETLIFY_HOSTING_COVERAGE),
		);
	});
});

describe("Netlify resolver telemetry", () => {
	it("emits a typed-outcome metric even when a call is refused", async () => {
		const points: ResolverMetricPoint[] = [];
		const registry = netlifyResolverRegistry({
			...options,
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
						slot: "web",
						productId: "netlify.other/v1",
						logicalId: "x",
					},
					desired: {},
					credentialRef: "vault://netlify/token",
				},
				refuse,
			),
		).rejects.toBeInstanceOf(ResolverError);
		expect(points[0]?.name).toBe(RESOLVER_OPERATIONS_METRIC);
		expect(points[0]?.attributes["hobo.provider.id"]).toBe("netlify");
	});
});
