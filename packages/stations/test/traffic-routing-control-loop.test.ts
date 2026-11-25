import assert from "node:assert/strict";
import { createSimpleTrafficRouting } from "@hobo/connectivity";
import {
	allowDecision,
	denyDecision,
	type PolicyDecision,
	parseMinAvailabilitySpec,
	parseTenantId,
} from "@hobo/core";
import { test } from "vitest";

import {
	createRoutingControlLoop,
	ROUTING_LOOP_EVENTS,
} from "../src/traffic-routing/control-loop.js";
import type { RoutingTopology } from "../src/traffic-routing/synthesize.js";

const tenantId = parseTenantId("tenant-a");

function policyDecision(effect: "allow" | "deny" = "allow"): PolicyDecision {
	const request = {
		subject: { identity: "router", tenantId, tags: [] },
		action: "routing.plan",
		resource: { kind: "service", id: "checkout", tenantId },
	};
	return effect === "allow"
		? allowDecision("test-policy", request)
		: denyDecision("test-policy", request, ["routing denied"]);
}

const TOPOLOGY: RoutingTopology = {
	service: "checkout",
	tenantId,
	stationId: "station:prod",
	costRouting: "stateless",
	backends: [
		{
			id: "backend:vercel",
			service: "checkout",
			locationHints: ["region:iad1"],
			healthy: true,
		},
		{
			id: "backend:lakebed",
			service: "checkout",
			locationHints: ["region:us-central1"],
			healthy: true,
		},
	],
};

const COST_MODEL = [
	{ backendId: "backend:vercel", listUnitCost: 0.05 },
	{ backendId: "backend:lakebed", listUnitCost: 0.01 },
];

function budgetSignal(cycle = 1) {
	return {
		kind: "budget" as const,
		fact: {
			type: "budget.ThresholdCrossed",
			data: { tenantId: "tenant-a", thresholdFraction: 0.8, cycle },
		},
	};
}

test("milestone: a budget signal re-dispatches to the cheaper backend and re-applies the plan in full", async () => {
	const port = createSimpleTrafficRouting();
	const facts: { type: string }[] = [];
	const loop = createRoutingControlLoop({
		ledgerView: () => ({
			view: "CreditLedgerView" as const,
			seq: 0,
			accounts: [],
		}),
		persistState: async () => {},
		beforeApply: async () => {},
		healthGate: () => true,
		topology: TOPOLOGY,
		policyDecision: policyDecision(),
		costModel: COST_MODEL,
		port,
		stability: { cooldownSeconds: 60 },
		incumbentBackendId: "backend:vercel",
		units: 100,
		clock: () => "2026-08-03T00:00:00.000Z",
		onFact: (fact) => facts.push({ type: fact.type }),
	});

	const outcome = await loop.handleSignal(budgetSignal());

	assert.equal(outcome.action, "reapplied");
	assert.equal(outcome.selectedBackendId, "backend:lakebed");
	assert.equal(outcome.applyResult.realized, "full");
	assert.equal(loop.incumbent(), "backend:lakebed");
	assert.equal(
		outcome.plan.backends.find((backend) => backend.id === "backend:lakebed")
			?.weight,
		100,
	);
	assert.deepEqual(
		facts.map((fact) => fact.type),
		[
			"dispatch.Decided",
			ROUTING_LOOP_EVENTS.ReplanProposed,
			ROUTING_LOOP_EVENTS.Reapplied,
		],
	);
	const status = await port.status(outcome.plan.planId);
	assert.equal(status?.active, true);
});

test("milestone: two rapid signals produce exactly one swap — the second is held by cooldown, and applies after it expires", async () => {
	const port = createSimpleTrafficRouting();
	// Ledger list-unit-costs override the static cost model, so flipping the
	// ledger makes the loop want to swap back immediately.
	let accounts = [
		accountFor("backend:vercel", 0.05),
		accountFor("backend:lakebed", 0.01),
	];
	let seq = 1;
	let nowIso = "2026-08-03T00:00:00.000Z";
	const loop = createRoutingControlLoop({
		persistState: async () => {},
		beforeApply: async () => {},
		healthGate: () => true,
		topology: TOPOLOGY,
		policyDecision: policyDecision(),
		costModel: COST_MODEL,
		ledgerView: () => ({
			view: "CreditLedgerView",
			seq: seq++,
			accounts,
		}),
		port,
		stability: { cooldownSeconds: 60 },
		incumbentBackendId: "backend:vercel",
		units: 100,
		clock: () => nowIso,
	});

	const first = await loop.handleSignal(budgetSignal(1));
	assert.equal(first.action, "reapplied");
	assert.equal(loop.incumbent(), "backend:lakebed");

	// Prices flip 5 seconds later: the loop wants vercel back, but cooldown
	// holds it — exactly one applied swap so far.
	accounts = [
		accountFor("backend:vercel", 0.01),
		accountFor("backend:lakebed", 0.05),
	];
	nowIso = "2026-08-03T00:00:05.000Z";
	const second = await loop.handleSignal(budgetSignal(2));
	assert.equal(second.action, "held");
	assert.equal(second.reason, "cooldown");
	assert.equal(loop.incumbent(), "backend:lakebed");
	assert.equal(loop.revision(), 1);

	// After the cooldown window the same pressure applies cleanly.
	nowIso = "2026-08-03T00:02:00.000Z";
	const third = await loop.handleSignal(budgetSignal(3));
	assert.equal(third.action, "reapplied");
	assert.equal(loop.incumbent(), "backend:vercel");
	assert.equal(loop.revision(), 2);
});

test("milestone: an unhealthy-backend observation refuses the replan with availability-unsatisfied", async () => {
	const port = createSimpleTrafficRouting();
	const loop = createRoutingControlLoop({
		ledgerView: () => ({
			view: "CreditLedgerView" as const,
			seq: 0,
			accounts: [],
		}),
		persistState: async () => {},
		beforeApply: async () => {},
		healthGate: () => true,
		topology: TOPOLOGY,
		availability: parseMinAvailabilitySpec({ minHealthyBackends: 2 }),
		policyDecision: policyDecision(),
		costModel: COST_MODEL,
		port,
		stability: { cooldownSeconds: 60 },
		incumbentBackendId: "backend:vercel",
		units: 100,
		clock: () => "2026-08-03T00:00:00.000Z",
	});

	const outcome = await loop.handleSignal({
		kind: "health",
		observations: {
			backends: [
				{ backendId: "backend:vercel", healthy: false },
				{ backendId: "backend:lakebed", healthy: true },
			],
			source: "observe.health",
		},
	});

	assert.equal(outcome.action, "denied");
	assert.equal(outcome.reasons[0]?.code, "availability-unsatisfied");
	assert.equal(loop.incumbent(), "backend:vercel");
	assert.equal(loop.revision(), 0);
});

test("policy deny fails the loop closed before any apply", async () => {
	const port = createSimpleTrafficRouting();
	const applied: string[] = [];
	const originalApply = port.apply.bind(port);
	const trackingPort = {
		...port,
		apply: async (plan) => {
			applied.push(String(plan.planId));
			return originalApply(plan);
		},
	};
	const loop = createRoutingControlLoop({
		ledgerView: () => ({
			view: "CreditLedgerView" as const,
			seq: 0,
			accounts: [],
		}),
		persistState: async () => {},
		beforeApply: async () => {},
		healthGate: () => true,
		topology: TOPOLOGY,
		policyDecision: policyDecision("deny"),
		costModel: COST_MODEL,
		port: trackingPort,
		stability: { cooldownSeconds: 60 },
		incumbentBackendId: "backend:vercel",
		clock: () => "2026-08-03T00:00:00.000Z",
	});

	const outcome = await loop.handleSignal(budgetSignal());

	assert.equal(outcome.action, "denied");
	assert.equal(outcome.reasons[0]?.code, "policy-denied");
	assert.deepEqual(applied, []);
});

test("flip limit holds a swap even after cooldown has expired", async () => {
	const port = createSimpleTrafficRouting();
	let accounts = [
		accountFor("backend:vercel", 0.05),
		accountFor("backend:lakebed", 0.01),
	];
	let seq = 1;
	let nowIso = "2026-08-03T00:00:00.000Z";
	const loop = createRoutingControlLoop({
		persistState: async () => {},
		beforeApply: async () => {},
		healthGate: () => true,
		topology: TOPOLOGY,
		policyDecision: policyDecision(),
		costModel: COST_MODEL,
		ledgerView: () => ({ view: "CreditLedgerView", seq: seq++, accounts }),
		port,
		stability: {
			cooldownSeconds: 1,
			maxSwapsPerWindow: 1,
			windowSeconds: 3600,
		},
		incumbentBackendId: "backend:vercel",
		units: 100,
		clock: () => nowIso,
	});

	assert.equal((await loop.handleSignal(budgetSignal(1))).action, "reapplied");

	accounts = [
		accountFor("backend:vercel", 0.01),
		accountFor("backend:lakebed", 0.05),
	];
	nowIso = "2026-08-03T00:05:00.000Z";
	const outcome = await loop.handleSignal(budgetSignal(2));
	assert.equal(outcome.action, "held");
	assert.equal(outcome.reason, "flip-limit");
});

function accountFor(backendId: string, listUnitCost: number) {
	return {
		providerId: backendId,
		dimension: "traffic.requests",
		listUnitCost,
		freeHeadroom: 0,
		rateHeadroom: 1000,
		concurrencyHeadroom: 10,
		credits: [],
	};
}
