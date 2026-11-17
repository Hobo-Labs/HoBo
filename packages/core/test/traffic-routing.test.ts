import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toJson } from "@bufbuild/protobuf";
import { test } from "vitest";

import { TrafficRoutingPlanRecordSchema } from "../src/_generated/traffic_routing_pb.js";
import {
	createTrafficRoutingMeteringEvent,
	parseApplyResult,
	parseRevokeResult,
	parseRoutingPlan,
	parseRoutingRule,
	parseRoutingWeight,
	parseTrafficRoutingPlanRecord,
	TrafficRoutingParseError,
	type TrafficRoutingPort,
	toTrafficRoutingPlanRecord,
} from "../src/ports/traffic-routing.js";

const HASH = `sha256:${"a".repeat(64)}`;

function goldenPlan() {
	return {
		planId: "plan:checkout:v3",
		intent: {
			service: "checkout",
			tenantId: "tenant-a",
			rules: [
				{
					match: { pathPrefix: "/api", headers: { "x-lane": "canary" } },
					backends: [
						{
							id: "backend:primary",
							service: "checkout-v3",
							locationHints: ["us-central1"],
							weight: 90,
							endpoint: "https://primary.example.test",
						},
						{
							id: "backend:canary",
							service: "checkout-v4",
							locationHints: ["us-east1"],
							weight: 10,
						},
					],
					weightStrategy: "prefer-healthy",
				},
			],
			availability: {
				minHealthyBackends: 1,
				minDistinctLocations: 2,
				locationLabels: ["region"],
			},
			resiliency: { timeoutMs: 2_000, retries: 2 },
		},
		backends: [
			{
				id: "backend:primary",
				service: "checkout-v3",
				locationHints: ["us-central1"],
				weight: 90,
				endpoint: "https://primary.example.test",
			},
			{
				id: "backend:canary",
				service: "checkout-v4",
				locationHints: ["us-east1"],
				weight: 10,
			},
		],
		stationId: "station:prod",
		railHash: HASH,
		createdAt: "2026-08-03T15:00:00.000Z",
		notes: ["canary"],
	};
}

test("parses and deeply freezes a traffic routing plan", () => {
	const plan = parseRoutingPlan(goldenPlan());

	assert.equal(plan.planId, "plan:checkout:v3");
	assert.equal(plan.intent.rules[0]?.backends[1]?.weight, 10);
	assert.ok(Object.isFrozen(plan));
	assert.ok(Object.isFrozen(plan.intent.rules));
	assert.ok(Object.isFrozen(plan.intent.rules[0]?.match?.headers));
});

test("fails closed on malformed routing values", () => {
	assert.throws(
		() => parseRoutingPlan({ ...goldenPlan(), createdAt: "tomorrow" }),
		TrafficRoutingParseError,
	);
	const plan = goldenPlan();
	const backend = plan.intent.rules[0]?.backends[0];
	assert.ok(backend);
	backend.weight = 101;
	assert.throws(() => parseRoutingPlan(plan), /weight/);
	assert.throws(() => parseRoutingWeight(0), TrafficRoutingParseError);

	const credentialPlan = goldenPlan();
	const credentialBackend = credentialPlan.intent.rules[0]?.backends[0];
	assert.ok(credentialBackend);
	credentialBackend.endpoint = "https://user:secret@primary.example.test";
	assert.throws(() => parseRoutingPlan(credentialPlan), /credentials/);

	const queryPlan = goldenPlan();
	const queryRuleBackend = queryPlan.intent.rules[0]?.backends[0];
	const queryCanonicalBackend = queryPlan.backends[0];
	assert.ok(queryRuleBackend);
	assert.ok(queryCanonicalBackend);
	queryRuleBackend.endpoint = "https://primary.example.test?token=secret";
	queryCanonicalBackend.endpoint = "https://primary.example.test?token=secret";
	assert.throws(() => parseRoutingPlan(queryPlan), /query/);

	const swapped = goldenPlan();
	const swappedBackend = swapped.intent.rules[0]?.backends[0];
	assert.ok(swappedBackend);
	swappedBackend.endpoint = "https://attacker.example.test";
	assert.throws(() => parseRoutingPlan(swapped), /exactly matching/);
});

test("round-trips generated protobuf records and protobuf JSON", () => {
	const plan = parseRoutingPlan(goldenPlan());
	const record = toTrafficRoutingPlanRecord(plan);
	const json = toJson(TrafficRoutingPlanRecordSchema, record);

	assert.equal(
		(json.intent as { rules: { weightStrategy: string }[] }).rules[0]
			?.weightStrategy,
		"WEIGHT_STRATEGY_PREFER_HEALTHY",
	);
	assert.deepEqual(
		parseTrafficRoutingPlanRecord(json),
		parseTrafficRoutingPlanRecord(record),
	);
	assert.deepEqual(parseTrafficRoutingPlanRecord(record), {
		...plan,
		degraded: plan.degraded ?? false,
		notes: plan.notes ?? [],
	});
	assert.equal(
		parseTrafficRoutingPlanRecord(record).intent.rules[0]?.weightStrategy,
		"prefer-healthy",
	);
});

test("defaults an omitted weight strategy to static", () => {
	const rule = parseRoutingRule({
		backends: [{ id: "backend:primary", service: "checkout" }],
	});
	assert.equal(rule.weightStrategy, "static");
});

test("port contracts expose nullable status and structured revoke results", async () => {
	const port: TrafficRoutingPort = {
		provider: "simple",
		async apply(plan) {
			return parseApplyResult({
				planId: plan.planId,
				provider: "simple",
				realized: "full",
				notes: [],
				appliedRules: 1,
			});
		},
		async status() {
			return null;
		},
		async revoke() {
			return parseRevokeResult({ ok: true, notes: [] });
		},
	};
	const plan = parseRoutingPlan(goldenPlan());
	assert.equal(await port.status(plan.planId), null);
	assert.deepEqual(await port.revoke?.(plan.planId), { ok: true, notes: [] });
});

test("parses provider apply results and routing metering events", () => {
	const result = parseApplyResult({
		planId: "plan:checkout:v3",
		provider: "cloudflare",
		realized: "partial",
		notes: ["one location unavailable"],
		appliedRules: 1,
		unmet: ["minDistinctLocations"],
		capabilities: ["weighted-backends", "health-aware"],
	});
	assert.ok(Object.isFrozen(result.capabilities));

	const event = createTrafficRoutingMeteringEvent({
		tenantId: "tenant-a",
		planId: result.planId,
		provider: result.provider,
		outcome: "degraded",
		timestamp: "2026-08-03T15:01:00.000Z",
	});
	assert.deepEqual(event, {
		tenantId: "tenant-a",
		eventType: "routing.plan.degraded",
		resource: "plan:checkout:v3",
		quantity: 1,
		unit: "count",
		timestamp: "2026-08-03T15:01:00.000Z",
		metadata: { provider: "cloudflare" },
	});
	assert.ok(Object.isFrozen(event.metadata));
});

test("rejects contradictory realization results", () => {
	assert.throws(
		() =>
			parseApplyResult({
				planId: "plan:bad",
				provider: "simple",
				realized: "full",
				notes: [],
				appliedRules: 1,
				unmet: ["path-prefix"],
			}),
		TrafficRoutingParseError,
	);
	assert.throws(
		() =>
			parseApplyResult({
				planId: "plan:bad",
				provider: "simple",
				realized: "none",
				notes: [],
				appliedRules: 1,
			}),
		TrafficRoutingParseError,
	);
});

test("core routing contract has no Kubernetes or mesh-client dependency", () => {
	const source = readFileSync(
		new URL("../src/ports/traffic-routing.ts", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(
		source,
		/@kubernetes|kubernetes\/client|\b(?:istio|linkerd|cilium|gateway-api)\b/iu,
	);
});
