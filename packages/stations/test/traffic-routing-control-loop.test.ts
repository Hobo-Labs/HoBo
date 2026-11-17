import assert from "node:assert/strict";
import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { createSimpleTrafficRouting } from "@hobo/connectivity";
import {
	allowDecision,
	denyDecision,
	type PolicyDecision,
	parseMinAvailabilitySpec,
	parseTenantId,
} from "@hobo/core";
import { test } from "vitest";
import { foldBudgetSignals } from "../../broker/src/budget-signals.js";
import { RoutingControlStateRecordSchema } from "../src/_generated/routing_control_pb.js";
import {
	createRoutingControlLoop,
	ROUTING_LOOP_EVENTS,
} from "../src/traffic-routing/control-loop.js";
import type { RoutingTopology } from "../src/traffic-routing/synthesize.js";
import { budgetSignals } from "./fixtures/budget-signals.js";

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

test("milestone: a budget signal re-dispatches to the cheaper backend and re-applies the plan in full", async () => {
	const budget = budgetSignals(tenantId);
	const port = createSimpleTrafficRouting();
	const facts: { type: string }[] = [];
	const loop = createRoutingControlLoop({
		budgetSignalEvidence: budget.evidence,
		ledgerView: () => ({
			view: "CreditLedgerView" as const,
			seq: 0,
			accounts: [
				accountFor("backend:vercel", 0.05),
				accountFor("backend:lakebed", 0.01),
			],
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

	const outcome = await loop.handleSignal(budget.signal());

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
	const budget = budgetSignals(tenantId);
	const port = createSimpleTrafficRouting();
	let accounts = [
		accountFor("backend:vercel", 0.05),
		accountFor("backend:lakebed", 0.01),
	];
	let seq = 1;
	let nowIso = "2026-08-03T00:00:00.000Z";
	const loop = createRoutingControlLoop({
		budgetSignalEvidence: budget.evidence,
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

	const first = await loop.handleSignal(budget.signal(1));
	assert.equal(first.action, "reapplied");
	assert.equal(loop.incumbent(), "backend:lakebed");

	accounts = [
		accountFor("backend:vercel", 0.01),
		accountFor("backend:lakebed", 0.05),
	];
	nowIso = "2026-08-03T00:00:05.000Z";
	const heldSignal = budget.signal(2);
	const second = await loop.handleSignal(heldSignal);
	assert.equal(second.action, "held");
	assert.equal(second.reason, "cooldown");
	assert.equal(loop.incumbent(), "backend:lakebed");
	assert.equal(loop.revision(), 1);

	nowIso = "2026-08-03T00:02:00.000Z";
	const third = await loop.handleSignal(heldSignal);
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
	const budget = budgetSignals(tenantId);
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
		budgetSignalEvidence: budget.evidence,
		ledgerView: () => ({
			view: "CreditLedgerView" as const,
			seq: 0,
			accounts: [
				accountFor("backend:vercel", 0.05),
				accountFor("backend:lakebed", 0.01),
			],
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

	const outcome = await loop.handleSignal(budget.signal());

	assert.equal(outcome.action, "denied");
	assert.equal(outcome.reasons[0]?.code, "policy-denied");
	assert.deepEqual(applied, []);
});

test("budget signals fail closed without a current projection", async () => {
	const budget = budgetSignals(tenantId);
	const loop = createRoutingControlLoop({
		topology: TOPOLOGY,
		policyDecision: policyDecision(),
		costModel: COST_MODEL,
		port: createSimpleTrafficRouting(),
		stability: { cooldownSeconds: 0 },
		incumbentBackendId: "backend:vercel",
	});
	const outcome = await loop.handleSignal(budget.signal());
	assert.equal(outcome.action, "denied");
	assert.equal(outcome.reasons[0]?.code, "budget-signal-unverified");
	assert.equal(loop.revision(), 0);
});

test("budget signals require an authentic current threshold transition", async () => {
	const budget = budgetSignals(tenantId);
	const crossing = budget.signal();
	let observed = crossing.fact;
	let writes = 0;
	const loop = createRoutingControlLoop({
		budgetSignalEvidence: () => observed,
		ledgerView: () => ({
			view: "CreditLedgerView",
			seq: 1,
			accounts: [
				accountFor("backend:vercel", 0.05),
				accountFor("backend:lakebed", 0.01),
			],
		}),
		persistState: async () => {
			writes += 1;
		},
		beforeApply: async () => {},
		healthGate: () => true,
		topology: TOPOLOGY,
		policyDecision: policyDecision(),
		costModel: COST_MODEL,
		port: createSimpleTrafficRouting(),
		stability: { cooldownSeconds: 0 },
		incumbentBackendId: "backend:vercel",
	});
	const belowThreshold = {
		...crossing,
		fact: {
			...crossing.fact,
			data: { ...crossing.fact.data, netSpentUsd: 79 },
		},
	};
	observed = belowThreshold.fact;
	assert.equal((await loop.handleSignal(belowThreshold)).action, "denied");
	observed = budget.signal(2).fact;
	assert.equal((await loop.handleSignal(crossing)).action, "denied");
	assert.equal(writes, 0);
	assert.equal(loop.incumbent(), "backend:vercel");
	assert.equal(loop.revision(), 0);
});

test("an incomplete ledger cannot consume a budget transition", async () => {
	const budget = budgetSignals(tenantId);
	let accounts: ReturnType<typeof accountFor>[] = [];
	const loop = createRoutingControlLoop({
		budgetSignalEvidence: budget.evidence,
		ledgerView: () => ({ view: "CreditLedgerView", seq: 1, accounts }),
		persistState: async () => {},
		beforeApply: async () => {},
		healthGate: () => true,
		topology: TOPOLOGY,
		policyDecision: policyDecision(),
		costModel: COST_MODEL,
		port: createSimpleTrafficRouting(),
		stability: { cooldownSeconds: 0 },
		incumbentBackendId: "backend:vercel",
	});
	const signal = budget.signal();
	assert.equal((await loop.handleSignal(signal)).action, "denied");
	assert.deepEqual(loop.snapshot().budgetSignalCycles, {});
	accounts = [
		accountFor("backend:vercel", 0.05),
		accountFor("backend:lakebed", 0.01),
	];
	assert.equal((await loop.handleSignal(signal)).action, "reapplied");
});

test("scoped budget transitions must match the active policy revision", async () => {
	const identity = {
		tenantId,
		budgetId: "traffic",
		periodId: "period-1",
		policyRevision: "r1",
	};
	const crossing = foldBudgetSignals(
		[
			{
				type: "meter.UsageRecorded",
				data: { ...identity, costUsd: 80 },
			},
		],
		{ identity, budgetUsd: 100, thresholds: [0.8] },
	).signals.find((fact) => fact.type === "budget.ThresholdCrossed");
	assert.ok(crossing);
	const policy = {
		tenantId,
		budgetPolicy: {
			schemaVersion: "hobo.budget-policy/v1",
			tenantId,
			budgetId: identity.budgetId,
			periodId: identity.periodId,
			revision: "r1",
			workloads: ["ci"],
			currency: "USD",
			limitMicros: 100_000_000,
			objective: "min-cost",
			enforcement: "conservative",
			periodKind: "manual",
			constraints: [],
		},
	};
	const options = {
		budgetSignalEvidence: async () => crossing,
		ledgerView: () => ({
			view: "CreditLedgerView" as const,
			seq: 1,
			accounts: [
				accountFor("backend:vercel", 0.05),
				accountFor("backend:lakebed", 0.01),
			],
		}),
		persistState: async () => {},
		beforeApply: async () => {},
		healthGate: () => true,
		topology: TOPOLOGY,
		policyDecision: policyDecision(),
		costModel: COST_MODEL,
		port: createSimpleTrafficRouting(),
		stability: { cooldownSeconds: 0 },
		incumbentBackendId: "backend:vercel",
	};
	const signal = { kind: "budget" as const, fact: crossing };
	const stalePolicy = {
		...policy,
		budgetPolicy: { ...policy.budgetPolicy, revision: "r2" },
	};
	const rejected = createRoutingControlLoop({
		...options,
		budgetSignalPolicy: stalePolicy,
	});
	assert.equal((await rejected.handleSignal(signal)).action, "denied");
	assert.equal(rejected.revision(), 0);
	const accepted = createRoutingControlLoop({
		...options,
		budgetSignalPolicy: policy,
	});
	assert.equal((await accepted.handleSignal(signal)).action, "reapplied");
	const reset = foldBudgetSignals([], {
		identity,
		budgetUsd: 0,
		thresholds: [0.8],
	}).signals[0];
	assert.ok(reset);
	const zeroBudget = createRoutingControlLoop({
		...options,
		incumbentBackendId: "backend:lakebed",
		budgetSignalPolicy: {
			...policy,
			budgetPolicy: { ...policy.budgetPolicy, limitMicros: 0 },
		},
		budgetSignalEvidence: () => reset,
	});
	assert.equal(
		(await zeroBudget.handleSignal({ kind: "budget", fact: reset })).action,
		"noop",
	);
	const uncrossedReset = foldBudgetSignals([], {
		identity,
		budgetUsd: 100,
		thresholds: [0.8],
	}).signals[0];
	assert.ok(uncrossedReset);
	const uncrossed = createRoutingControlLoop({
		...options,
		budgetSignalPolicy: policy,
		budgetSignalEvidence: () => uncrossedReset,
	});
	assert.equal(
		(await uncrossed.handleSignal({ kind: "budget", fact: uncrossedReset }))
			.action,
		"denied",
	);
});

test("a processed budget transition cannot trigger another swap after restart", async () => {
	const budget = budgetSignals(tenantId);
	let accounts = [
		accountFor("backend:vercel", 0.05),
		accountFor("backend:lakebed", 0.01),
	];
	const options = {
		budgetSignalEvidence: budget.evidence,
		ledgerView: () => ({ view: "CreditLedgerView" as const, seq: 1, accounts }),
		persistState: async () => {},
		beforeApply: async () => {},
		healthGate: () => true,
		topology: TOPOLOGY,
		policyDecision: policyDecision(),
		costModel: COST_MODEL,
		port: createSimpleTrafficRouting(),
		stability: { cooldownSeconds: 0 },
		incumbentBackendId: "backend:vercel",
	};
	const signal = budget.signal();
	const first = createRoutingControlLoop(options);
	assert.equal((await first.handleSignal(signal)).action, "reapplied");
	const snapshot = fromJsonString(
		RoutingControlStateRecordSchema,
		toJsonString(RoutingControlStateRecordSchema, first.snapshot()),
	);
	accounts = [
		accountFor("backend:vercel", 0.01),
		accountFor("backend:lakebed", 0.05),
	];
	const restarted = createRoutingControlLoop({
		...options,
		initialState: snapshot,
	});
	const result = await restarted.handleSignal(signal);
	assert.deepEqual(result, {
		action: "noop",
		reason: "budget-signal-replayed",
		facts: [],
	});
	assert.equal(restarted.incumbent(), "backend:lakebed");
	assert.equal(restarted.revision(), 1);
});

test("flip limit holds a swap even after cooldown has expired", async () => {
	const budget = budgetSignals(tenantId);
	const port = createSimpleTrafficRouting();
	let accounts = [
		accountFor("backend:vercel", 0.05),
		accountFor("backend:lakebed", 0.01),
	];
	let seq = 1;
	let nowIso = "2026-08-03T00:00:00.000Z";
	const loop = createRoutingControlLoop({
		budgetSignalEvidence: budget.evidence,
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

	assert.equal((await loop.handleSignal(budget.signal(1))).action, "reapplied");

	accounts = [
		accountFor("backend:vercel", 0.01),
		accountFor("backend:lakebed", 0.05),
	];
	nowIso = "2026-08-03T00:05:00.000Z";
	const outcome = await loop.handleSignal(budget.signal(2));
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
