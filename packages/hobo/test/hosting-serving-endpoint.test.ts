import {
	parseResourceLifecycleObservation,
	parseRoutingPlan,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import { assertHostingServingEndpoints } from "../src/hosting-serving-endpoint.js";

function observed(servingEndpoint: string) {
	const scope = {
		tenantId: "tenant",
		providerId: "native",
		providerAccountId: "account",
		productId: "compute/v1",
		resourceId: "app",
		operationId: "prepare",
	};
	return parseResourceLifecycleObservation(
		{
			...scope,
			physicalId: "native-app",
			status: "ready",
			operationTerminal: true,
			servingEndpoint,
			observedAtMs: 1000,
			evidenceRef: "native:read",
			settledMicros: 0,
		},
		{ ...scope, nowMs: 1000, maxAgeMs: 100 },
	);
}
function routing(endpoints: string[]) {
	const backends = endpoints.map((endpoint, index) => ({
		id: `backend-${index}`,
		service: "app",
		endpoint,
	}));
	return parseRoutingPlan({
		planId: "routing:target",
		createdAt: "2026-10-30T00:00:00Z",
		backends,
		intent: {
			service: "app",
			tenantId: "tenant",
			rules: [{ backends, weightStrategy: "static" }],
		},
	});
}
describe("native endpoint, Station route and health binding", () => {
	it("accepts an observed native endpoint and a probe inside its serving path", () => {
		expect(
			assertHostingServingEndpoints({
				observations: [observed("https://native.example/v1")],
				routing: routing(["https://native.example/v1"]),
				healthUrls: ["https://native.example/v1/health"],
			}),
		).toEqual(["https://native.example/v1/health"]);
	});
	it("refuses a healthy response from a different origin before that response can authorize a route", () => {
		expect(() =>
			assertHostingServingEndpoints({
				observations: [observed("https://native.example/")],
				routing: routing(["https://native.example/"]),
				healthUrls: ["https://unrelated.example/health"],
			}),
		).toThrow("health probe does not belong");
	});
	it("does not substitute configured backend URLs for missing or foreign native readback", () => {
		expect(() =>
			assertHostingServingEndpoints({
				observations: [observed("https://native.example/")],
				routing: routing(["https://foreign.example/"]),
				healthUrls: ["https://foreign.example/health"],
			}),
		).toThrow("independently observed");
		expect(() =>
			assertHostingServingEndpoints({
				observations: [],
				routing: routing(["https://native.example/"]),
				healthUrls: ["https://native.example/health"],
			}),
		).toThrow("independently observed");
	});
	it("requires an independent probe for every active native backend", () => {
		const endpoints = ["https://one.example/", "https://two.example/"];
		expect(() =>
			assertHostingServingEndpoints({
				observations: endpoints.map(observed),
				routing: routing(endpoints),
				healthUrls: ["https://one.example/health"],
			}),
		).toThrow("every active");
		expect(
			assertHostingServingEndpoints({
				observations: endpoints.map(observed),
				routing: routing(endpoints),
				healthUrls: endpoints.map((url) => `${url}health`),
			}),
		).toHaveLength(2);
	});
	it("rejects sibling path prefixes, URL credentials, encoded separators and unapproved HTTP", () => {
		for (const probe of [
			"https://native.example/api-other/health",
			"https://user:secret@native.example/api/health",
			"https://native.example/api/%2fhealth",
		])
			expect(() =>
				assertHostingServingEndpoints({
					observations: [observed("https://native.example/api")],
					routing: routing(["https://native.example/api"]),
					healthUrls: [probe],
				}),
			).toThrow();
		const native = observed("http://127.0.0.1:8080/");
		expect(() =>
			assertHostingServingEndpoints({
				observations: [native],
				routing: routing([native.servingEndpoint]),
				healthUrls: ["http://127.0.0.1:8080/health"],
			}),
		).toThrow("HTTPS");
		expect(
			assertHostingServingEndpoints({
				observations: [native],
				routing: routing([native.servingEndpoint]),
				healthUrls: ["http://127.0.0.1:8080/health"],
				allowInsecureLoopback: true,
			}),
		).toHaveLength(1);
	});
});
