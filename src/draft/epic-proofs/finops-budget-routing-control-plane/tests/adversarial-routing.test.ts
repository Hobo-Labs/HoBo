import assert from "node:assert/strict";
import { test } from "vitest";
import {
	evaluateRoutingScenario,
	parseMetricContracts,
	routingInputHashes,
	runFinopsRoutingControlPlaneSimulation,
} from "../services/finops-routing-control-plane.js";

function route(input: Awaited<ReturnType<typeof fixture>>) {
	return evaluateRoutingScenario({
		...input,
		snapshot: {
			...input.snapshot,
			...routingInputHashes(input.candidates, input.metricContracts),
		},
	});
}

async function fixture() {
	const simulation = await runFinopsRoutingControlPlaneSimulation();
	return {
		id: "adversarial",
		intent: structuredClone(simulation.approvedRoute.parse.intent.intent),
		candidates: structuredClone(simulation.approvedRoute.constraints.allowed),
		metricContracts: structuredClone(
			simulation.approvedRoute.parse.metrics.contracts,
		),
		history: [],
		budgetState: {
			spendToDate: 0,
			committedCost: 0,
			uncertainCost: 0,
			recoveryReserve: 0,
		},
		snapshot: {
			catalogHash: "sha256:catalog-fixture",
			metricRegistryHash: "sha256:metrics-fixture",
			budgetId: "budget:tenant-a",
			periodId: "2026-07",
			policyRevision: "policy:v1",
			ledgerSeq: 73,
			observedAt: "2026-07-01T16:00:00.000Z",
		},
	};
}

test("latency and availability requirements reject candidates before scoring", async () => {
	const input = await fixture();
	input.candidates = [
		{ ...input.candidates[0], id: "too-slow", latencyP95Ms: 160 },
		{ ...input.candidates[0], id: "unreliable", reliability: 0.5 },
	];
	const result = route(input);
	assert.equal(result.status, "deny");
	assert.deepEqual(result.metricVectors, []);
	assert.ok(
		result.constraints.rejected.some((item) =>
			item.reasons.includes("latency-limit-exceeded"),
		),
	);
	assert.ok(
		result.constraints.rejected.some((item) =>
			item.reasons.includes("availability-floor-missing"),
		),
	);
});

test("a dominated but feasible incumbent remains protected by cooldown and flip limit", async () => {
	const input = await fixture();
	const incumbent = {
		...input.candidates.find(
			(candidate) => candidate.id === "candidate-balanced",
		),
		id: "current",
	};
	input.candidates = [
		incumbent,
		{
			...incumbent,
			id: "one-dollar-cheaper",
			monthlyCost: incumbent.monthlyCost - 1,
		},
	];
	input.history = [
		{
			candidateId: "current",
			decidedAt: "2026-07-01T15:59:59.000Z",
			flipsInWindow: 100,
		},
	];
	const result = route(input);
	assert.equal(result.stability.selectedCandidateId, "current");
	assert.equal(result.stability.overridden, true);
});

test("empty metric registry fails before a decision graph can claim evaluations", async () => {
	const input = await fixture();
	input.metricContracts = [];
	const result = route(input);
	assert.equal(result.status, "rejected");
	assert.equal(result.decisionGraph, undefined);
	assert.equal(parseMetricContracts([]).ok, false);
});

test("adding an unselected candidate does not renormalize existing scores", async () => {
	const input = await fixture();
	input.intent.budget.amount = 100_000;
	input.intent.constraints.maxCost = 20_000;
	input.intent.capability.requirements.latencyP95Ms = 200;
	const base = input.candidates[0];
	const a = {
		...base,
		id: "a",
		monthlyCost: 100,
		commitmentBound: 100,
		latencyP95Ms: 100,
		reliability: 0.98,
	};
	const b = {
		...a,
		id: "b",
		monthlyCost: 200,
		commitmentBound: 200,
		latencyP95Ms: 20,
	};
	const c = {
		...a,
		id: "extra",
		monthlyCost: 10_000,
		commitmentBound: 10_000,
		latencyP95Ms: 10,
		reliability: 0.99,
	};
	const before = route({ ...input, candidates: [a, b] });
	const after = route({ ...input, candidates: [a, b, c] });
	for (const id of ["a", "b"]) {
		assert.equal(
			before.preference.scored.find((candidate) => candidate.candidateId === id)
				.score,
			after.preference.scored.find((candidate) => candidate.candidateId === id)
				.score,
		);
	}
});

test("graph audit references actual pinned inputs and replay does not perform effects", async () => {
	const input = await fixture();
	const first = route(input);
	const replay = route(input);
	assert.deepEqual(replay, first);
	assert.equal(first.decisionGraph.snapshot.ledgerSeq, 73);
	assert.ok(
		first.decisionGraph.auditRefs.some((ref) => ref.includes("seq:73")),
	);
	assert.equal(first.planningEffects.purity, "pure");
	assert.equal(first.actionPlan.execution.effects.purity, "noRollback");
	assert.equal(first.actionPlan.execution.onUnknown, "reconcile");
});

test("existing commitments, unresolved exposure and recovery reserve consume the ceiling", async () => {
	const input = await fixture();
	input.intent.budget.amount = 100;
	input.intent.constraints.maxCost = 100;
	input.budgetState = {
		spendToDate: 72,
		committedCost: 8,
		uncertainCost: 3,
		recoveryReserve: 5,
	};
	const base = input.candidates[0];
	input.candidates = [
		{
			...base,
			id: "cheap-operating-expensive-move",
			monthlyCost: 8,
			transitionCost: 6,
			commitmentBound: 14,
		},
		{
			...base,
			id: "affordable-whole-transition",
			monthlyCost: 10,
			transitionCost: 1,
			commitmentBound: 11,
		},
	];
	const result = route(input);
	assert.equal(
		result.routingDecision.selectedCandidateId,
		"affordable-whole-transition",
	);
	assert.ok(
		result.policy.deniedCandidateIds.includes("cheap-operating-expensive-move"),
	);
});

test("a stale catalog digest cannot explain a changed candidate set", async () => {
	const input = await fixture();
	input.snapshot = {
		...input.snapshot,
		...routingInputHashes(input.candidates, input.metricContracts),
	};
	input.candidates[0].monthlyCost += 1;
	input.candidates[0].commitmentBound += 1;
	const result = evaluateRoutingScenario(input);
	assert.equal(result.status, "rejected");
	assert.match(result.parse.errors.join(" "), /content hashes/);
});

test("malformed money and duplicate identities fail at the input boundary", async () => {
	for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.0000001]) {
		const input = await fixture();
		input.intent.budget.amount = amount;
		assert.equal(route(input).status, "rejected");
	}
	const input = await fixture();
	input.candidates.push(structuredClone(input.candidates[0]));
	assert.equal(route(input).status, "rejected");
});

test("missing financial exposure or a foreign accounting period is not zero exposure", async () => {
	const input = await fixture();
	delete input.budgetState.uncertainCost;
	assert.equal(route(input).status, "rejected");
	const otherPeriod = await fixture();
	otherPeriod.snapshot.periodId = "2026-08";
	assert.equal(route(otherPeriod).status, "rejected");
});

test("system semantics, metric dependencies, and approvals are verified", async () => {
	for (const mutate of [
		(metrics) => {
			metrics.find((item) => item.name === "cost.monthly").normalization =
				"candidate-relative";
		},
		(metrics) => {
			metrics.find((item) => item.tier === "user").approvalState = "pending";
		},
		(metrics) => {
			metrics.find((item) => item.tier === "derived").dependsOn[0] = "unknown";
		},
		(metrics) => {
			const derived = metrics.find((item) => item.tier === "derived");
			derived.dependsOn = [derived.name];
			derived.weights = { [derived.name]: 1 };
		},
		(metrics) => {
			metrics.push(structuredClone(metrics[0]));
		},
	]) {
		const input = await fixture();
		mutate(input.metricContracts);
		assert.equal(route(input).status, "rejected");
	}
});

test("approved derived and user compositions actually compute their declared weights", async () => {
	const input = await fixture();
	const result = route(input);
	for (const vector of result.metricVectors) {
		const normalized = vector.normalizedMetrics;
		const experienced =
			Math.round(
				(normalized["reliability.uptime"] * 0.7 +
					normalized["latency.p95"] * 0.3) *
					1_000_000,
			) / 1_000_000;
		const business =
			Math.round(
				(experienced * 0.7 + normalized["cost.monthly"] * 0.3) * 1_000_000,
			) / 1_000_000;
		assert.equal(vector.customMetrics["experienced.reliability"], experienced);
		assert.equal(vector.customMetrics["business.quality"], business);
	}
	input.metricContracts.find(
		(item) => item.name === "experienced.reliability",
	).weights = { "reliability.uptime": 0, "latency.p95": 1 };
	const changed = route(input);
	assert.notEqual(
		changed.metricVectors[0].customMetrics["experienced.reliability"],
		result.metricVectors[0].customMetrics["experienced.reliability"],
	);
});

test("a challenger needs sustained margin evidence in addition to cooldown", async () => {
	const input = await fixture();
	input.intent.routing.objective = "cost";
	const incumbent = {
		...input.candidates[0],
		id: "current",
		monthlyCost: 100,
		commitmentBound: 100,
	};
	const challenger = {
		...incumbent,
		id: "cheap",
		monthlyCost: 0,
		commitmentBound: 0,
	};
	input.candidates = [incumbent, challenger];
	input.history = [
		{ candidateId: "current", decidedAt: "2026-06-30T00:00:00.000Z" },
	];
	input.stability = {
		minImprovementThreshold: 0,
		cooldownMs: 0,
		migrationPenalty: 0,
		flipLimitPerWindow: 2,
		flipWindowMs: 86_400_000,
		dwellMs: 3_600_000,
	};
	assert.equal(route(input).routingDecision.selectedCandidateId, "current");
	input.history[0].challengerCandidateId = "cheap";
	input.history[0].challengerSince = "2026-07-01T14:00:00.000Z";
	assert.equal(route(input).routingDecision.selectedCandidateId, "cheap");
});

test("an infeasible incumbent cannot be held by cooldown, dwell or flip limits", async () => {
	const input = await fixture();
	const incumbent = {
		...input.candidates[0],
		id: "unhealthy",
		reliability: 0.5,
	};
	input.candidates.push(incumbent);
	input.history = [
		{
			candidateId: "unhealthy",
			decidedAt: "2026-07-01T15:59:59.000Z",
			flipsInWindow: 100,
		},
	];
	const result = route(input);
	assert.notEqual(result.routingDecision.selectedCandidateId, "unhealthy");
	assert.equal(result.stability.reason, "incumbent-infeasible-recovery");
});

test("zero is a hard ceiling and decimal USD sums are exact at the microdollar boundary", async () => {
	const input = await fixture();
	input.intent.budget.amount = 0;
	assert.equal(route(input).status, "deny");
	input.intent.budget.amount = 0.3;
	input.intent.budget.softLimitBehavior = "notify";
	input.intent.constraints.maxCost = 0.3;
	input.candidates = [
		{
			...input.candidates[0],
			monthlyCost: 0.1,
			transitionCost: 0.2,
			commitmentBound: 0.3,
		},
	];
	const result = route(input);
	assert.equal(result.status, "allow");
	assert.equal(result.policy.candidatePolicies[0].projectedCost, 0.3);
});

test("a denied plan claims no metric evaluations and external mutation retries are absent", async () => {
	const input = await fixture();
	input.intent.budget.amount = 0;
	const result = route(input);
	assert.deepEqual(result.decisionGraph.metricsEvaluated, {
		systemMetrics: [],
		derivedMetrics: [],
		userMetrics: [],
	});
	assert.equal(result.actionPlan.execution.authorized, false);
	assert.ok(
		result.actionPlan.execution.mutationResilience.strategies.every(
			(item) => item.kind !== "retry" && item.kind !== "hedging",
		),
	);
	assert.ok(
		result.actionPlan.execution.observationResilience.neverRetry.includes(
			"policy.Decided",
		),
	);
});

test("metric identifiers cannot resolve inherited object properties as measurements", async () => {
	const input = await fixture();
	const derived = input.metricContracts.find((item) => item.tier === "derived");
	input.metricContracts.push({ ...derived, name: "constructor" });
	const result = route(input);
	assert.equal(result.status, "allow");
	assert.ok(
		result.metricVectors.every((vector) =>
			Number.isFinite(vector.customMetrics.constructor),
		),
	);
});

test("opaque owner names are not interpreted as provider instructions", async () => {
	const input = await fixture();
	input.intent.owner.workspace = "aws-project";
	assert.equal(route(input).status, "allow");
});

test("cost-only routing retains exact monetary ordering below displayed score precision", async () => {
	const input = await fixture();
	input.intent.routing.objective = "cost";
	const candidate = input.candidates[0];
	input.candidates = [
		{
			...candidate,
			id: "a-paid",
			reliability: 1,
			monthlyCost: 0.000001,
			commitmentBound: 0.000001,
		},
		{ ...candidate, id: "z-free", monthlyCost: 0, commitmentBound: 0 },
	];
	assert.equal(route(input).routingDecision.selectedCandidateId, "z-free");
});

test("spoofed protobuf type tags cannot bypass JSON structural decoding", async () => {
	const input = await fixture();
	input.intent.owner.tenant = [];
	assert.equal(evaluateRoutingScenario(input).status, "rejected");
});
