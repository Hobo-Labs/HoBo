import assert from "node:assert/strict";
import {
	allowDecision,
	denyDecision,
	type PolicyDecision,
	parseMinAvailabilitySpec,
	parseTenantId,
} from "@hobo/core";
import { test } from "vitest";

import {
	applyRoutingObservations,
	type RoutingObservations,
} from "../src/traffic-routing/observations.js";
import { synthesizeRoutingPlan } from "../src/traffic-routing/synthesize.js";

const tenantId = parseTenantId("tenant-a");

function policyDecision(effect: "allow" | "deny"): PolicyDecision {
	const request = {
		subject: { identity: "router", tenantId, tags: [] },
		action: "routing.plan",
		resource: { kind: "service", id: "checkout", tenantId },
	};
	return effect === "allow"
		? allowDecision("test-policy", request)
		: denyDecision("test-policy", request, ["routing denied"]);
}

test("fails closed when Station context is missing", () => {
	const result = synthesizeRoutingPlan({
		topology: {
			service: "checkout",
			tenantId,
			backends: [{ id: "backend:primary", service: "checkout" }],
		},
		policyDecision: policyDecision("allow"),
		now: "2026-08-03T15:00:00.000Z",
	});

	assert.deepEqual(result, {
		kind: "denied",
		reasons: [
			{
				code: "station-missing",
				message: "routing synthesis requires Station context",
			},
		],
	});
	assert.ok(Object.isFrozen(result));
	assert.ok(Object.isFrozen(result.reasons));
	assert.ok(Object.isFrozen(result.reasons[0]));
});

test("returns a typed denial when policy denies routing", () => {
	const result = synthesizeRoutingPlan({
		topology: {
			service: "checkout",
			tenantId,
			stationId: "station:prod",
			backends: [{ id: "backend:primary", service: "checkout" }],
		},
		policyDecision: policyDecision("deny"),
	});

	assert.deepEqual(result, {
		kind: "denied",
		reasons: [{ code: "policy-denied", message: "routing denied" }],
	});
});

test("fails closed when an allow decision targets a different service", () => {
	const decision = policyDecision("allow");
	const result = synthesizeRoutingPlan({
		topology: {
			service: "checkout",
			tenantId,
			stationId: "station:prod",
			backends: [{ id: "backend:primary", service: "checkout" }],
		},
		policyDecision: {
			...decision,
			audit: { ...decision.audit, resourceId: "different-service" },
		},
	});

	assert.deepEqual(result, {
		kind: "denied",
		reasons: [
			{
				code: "policy-context-mismatch",
				message: "routing policy decision does not match the topology context",
			},
		],
	});
});

test("fails closed when an allow decision has unresolved obligations", () => {
	const decision = policyDecision("allow");
	const result = synthesizeRoutingPlan({
		topology: {
			service: "checkout",
			tenantId,
			stationId: "station:prod",
			backends: [{ id: "backend:primary", service: "checkout" }],
		},
		policyDecision: { ...decision, obligations: ["approval:security"] },
	});

	assert.deepEqual(result, {
		kind: "denied",
		reasons: [
			{
				code: "policy-obligations-unsatisfied",
				message:
					"routing policy obligations require explicit satisfaction evidence",
			},
		],
	});
});

test("synthesizes a degraded best-effort plan when availability signals are missing", () => {
	const result = synthesizeRoutingPlan({
		topology: {
			service: "checkout",
			tenantId,
			stationId: "station:prod",
			railHash: `sha256:${"a".repeat(64)}`,
			backends: [{ id: "backend:primary", service: "checkout" }],
		},
		availability: parseMinAvailabilitySpec({
			minHealthyBackends: 1,
			minDistinctLocations: 1,
		}),
		policyDecision: policyDecision("allow"),
		planId: "plan:checkout",
		now: "2026-08-03T15:00:00.000Z",
	});

	assert.equal(result.kind, "plan");
	if (result.kind !== "plan") return;
	assert.equal(result.plan.degraded, true);
	assert.equal(result.plan.stationId, "station:prod");
	assert.ok(
		result.plan.notes?.some((note) => /health signal.*best effort/u.test(note)),
	);
	assert.ok(
		result.plan.notes?.some((note) =>
			/location signal.*best effort/u.test(note),
		),
	);
	assert.ok(
		result.plan.notes?.some((note) =>
			/0 confirmed healthy.*requires 1/u.test(note),
		),
	);
	assert.ok(
		result.plan.notes?.some((note) =>
			/0 known location.*requires 1/u.test(note),
		),
	);
	assert.ok(Object.isFrozen(result));
	assert.ok(Object.isFrozen(result.plan));
});

test("applies observe.health/location then synthesizes non-degraded plan", () => {
	const topology = {
		service: "checkout",
		tenantId,
		stationId: "station:prod",
		backends: [
			{
				id: "backend:primary",
				service: "checkout",
				endpoint: "https://checkout.example.test",
				weight: 100,
			},
			{
				id: "backend:canary",
				service: "checkout",
				endpoint: "https://canary.example.test",
				weight: 20,
			},
		],
	};
	const observations: RoutingObservations = {
		source: "cloudflare.observe.health",
		observedAt: "2026-08-03T15:00:00.000Z",
		backends: [
			{
				backendId: "backend:primary",
				healthy: true,
				locationHints: ["region:us-central1"],
			},
			{
				backendId: "backend:canary",
				healthy: true,
				locationHints: ["region:us-east1"],
			},
		],
	};
	const observed = applyRoutingObservations(topology, observations);
	assert.equal(observed.backends[0]?.healthy, true);
	assert.deepEqual(observed.backends[0]?.locationHints, ["region:us-central1"]);

	const degradedWithout = synthesizeRoutingPlan({
		topology,
		availability: parseMinAvailabilitySpec({
			minHealthyBackends: 1,
			minDistinctLocations: 1,
		}),
		policyDecision: policyDecision("allow"),
		now: "2026-08-03T15:00:00.000Z",
	});
	assert.equal(degradedWithout.kind, "plan");
	if (degradedWithout.kind === "plan") {
		assert.equal(degradedWithout.plan.degraded, true);
	}

	const result = synthesizeRoutingPlan({
		topology: observed,
		availability: parseMinAvailabilitySpec({
			minHealthyBackends: 1,
			minDistinctLocations: 1,
		}),
		policyDecision: policyDecision("allow"),
		now: "2026-08-03T15:00:00.000Z",
	});
	assert.equal(result.kind, "plan");
	if (result.kind !== "plan") return;
	assert.equal(result.plan.degraded, undefined);
	assert.equal(result.plan.backends.length, 2);
});

test("synthesizes a non-degraded plan from complete healthy topology signals", () => {
	const result = synthesizeRoutingPlan({
		topology: {
			service: "checkout",
			tenantId,
			stationId: "station:prod",
			backends: [
				{
					id: "backend:primary",
					service: "checkout",
					locationHints: ["us-central1"],
					endpoint: "https://checkout.example.test",
					weight: 100,
					healthy: true,
				},
			],
		},
		availability: parseMinAvailabilitySpec({
			minHealthyBackends: 1,
			minDistinctLocations: 1,
		}),
		policyDecision: policyDecision("allow"),
		now: "2026-08-03T15:00:00.000Z",
	});

	assert.equal(result.kind, "plan");
	if (result.kind !== "plan") return;
	assert.equal(result.plan.degraded, undefined);
	assert.equal(
		result.plan.backends[0]?.endpoint,
		"https://checkout.example.test",
	);
	assert.deepEqual(result.plan.intent.rules[0]?.backends, result.plan.backends);
});

test("denies confirmed minimum-availability violations", () => {
	const result = synthesizeRoutingPlan({
		topology: {
			service: "checkout",
			tenantId,
			stationId: "station:prod",
			backends: [
				{
					id: "backend:primary",
					service: "checkout",
					healthy: false,
				},
			],
		},
		availability: parseMinAvailabilitySpec({ minHealthyBackends: 1 }),
		policyDecision: policyDecision("allow"),
	});

	assert.deepEqual(result, {
		kind: "denied",
		reasons: [
			{
				code: "availability-unsatisfied",
				message:
					"routing topology has no backend that is not confirmed unhealthy",
			},
		],
	});
});

test("evaluates the declared location labels and excludes unhealthy backends", () => {
	const result = synthesizeRoutingPlan({
		topology: {
			service: "checkout",
			tenantId,
			stationId: "station:prod",
			backends: [
				{
					id: "backend:healthy",
					service: "checkout",
					locationHints: ["region:us-central1", "cloud:gcp"],
					healthy: true,
				},
				{
					id: "backend:unhealthy",
					service: "checkout",
					locationHints: ["region:us-east1", "cloud:aws"],
					healthy: false,
				},
			],
		},
		availability: parseMinAvailabilitySpec({
			minHealthyBackends: 1,
			minDistinctLocations: 1,
			locationLabels: ["region", "cloud"],
		}),
		policyDecision: policyDecision("allow"),
	});

	assert.equal(result.kind, "plan");
	if (result.kind !== "plan") return;
	assert.deepEqual(
		result.plan.backends.map(({ id }) => id),
		["backend:healthy"],
	);
	assert.equal(result.plan.degraded, true);
	assert.ok(
		result.plan.notes?.includes("1 confirmed unhealthy backend(s) excluded"),
	);
});

test("derives creation time from the parsed policy decision without reading a clock", () => {
	const decision = policyDecision("allow");
	const decidedAt = "2026-08-03T15:02:00.000Z";
	const result = synthesizeRoutingPlan({
		topology: {
			service: "checkout",
			tenantId,
			stationId: "station:prod",
			backends: [
				{
					id: "backend:primary",
					service: "checkout",
					locationHints: ["us-central1"],
					healthy: true,
				},
			],
		},
		policyDecision: {
			...decision,
			audit: { ...decision.audit, decidedAt },
		},
	});

	assert.equal(result.kind, "plan");
	if (result.kind !== "plan") return;
	assert.equal(result.plan.createdAt, decidedAt);
});
