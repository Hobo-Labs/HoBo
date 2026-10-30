// Promoted domain-cutover-saga-contract invariants, re-expressed over the
// routing port: fail-closed preconditions refuse before any traffic moves,
// TTL/RTO evidence rides the event ladder, and rollback hysteresis absorbs
// single-sample health flaps.
import assert from "node:assert/strict";
import { createSimpleTrafficRouting } from "@hobo/connectivity";
import {
	allowDecision,
	type PolicyDecision,
	parseTenantId,
	type RoutingPlanId,
} from "@hobo/core";
import { test } from "vitest";

import { isJsonObject } from "../src/json.js";
import {
	CUTOVER_EVENTS,
	type CutoverPrecondition,
	executeRoutingCutover,
	type RoutingCutoverOptions,
} from "../src/traffic-routing/cutover.js";
import {
	type RoutingTopology,
	synthesizeRoutingPlan,
} from "../src/traffic-routing/synthesize.js";

const tenantId = parseTenantId("tenant-a");

function policyDecision(): PolicyDecision {
	return allowDecision("test-policy", {
		subject: { identity: "router", tenantId, tags: [] },
		action: "routing.plan",
		resource: { kind: "service", id: "checkout", tenantId },
	});
}

const TOPOLOGY: RoutingTopology = {
	service: "checkout",
	tenantId,
	stationId: "station:prod",
	backends: [
		{ id: "backend:a", service: "checkout", healthy: true },
		{ id: "backend:b", service: "checkout", healthy: true },
	],
};

const prior = synthesizeRoutingPlan({
	topology: {
		...TOPOLOGY,
		backends: [
			{ id: "backend:a", service: "checkout", healthy: true, weight: 100 },
		],
	},
	policyDecision: policyDecision(),
	planId: "plan:checkout:fixture-incumbent",
	weightStrategy: "static",
});
if (prior.kind !== "plan") throw new Error("invalid source fixture");
const INCUMBENT_PLAN = prior.plan;
function seededSimplePort() {
	const port = createSimpleTrafficRouting();
	void port.apply(INCUMBENT_PLAN);
	return port;
}
const VALID_TTL = {
	previousTtlSeconds: 300,
	loweredTtlSeconds: 30,
	waitedSeconds: 300,
} as const;

function validPrecondition(
	overrides: Partial<CutoverPrecondition> = {},
): CutoverPrecondition {
	return {
		validation: { status: "validated", changeId: "change-1" },
		ttl: VALID_TTL,
		incumbentPlanId: INCUMBENT_PLAN.planId,
		incumbentPlan: INCUMBENT_PLAN,
		...overrides,
	};
}

function cutoverOptions(
	overrides: Partial<RoutingCutoverOptions> = {},
): RoutingCutoverOptions {
	return {
		topology: TOPOLOGY,
		policyDecision: policyDecision(),
		port: seededSimplePort(),
		precondition: validPrecondition(),
		healthGate: () => true,
		restorationHealthGate: () => true,
		beforeApply: async () => {},
		fromBackendId: "backend:a",
		toBackendId: "backend:b",
		...overrides,
	};
}

test("an unvalidated change refuses the cutover before any traffic moves", async () => {
	const applied: string[] = [];
	const port = seededSimplePort();
	const spyPort = {
		...port,
		apply: async (plan: Parameters<typeof port.apply>[0]) => {
			applied.push(plan.planId);
			return port.apply(plan);
		},
		status: port.status.bind(port),
		select: port.select.bind(port),
		revoke: port.revoke.bind(port),
	};
	const result = await executeRoutingCutover(
		cutoverOptions({
			port: spyPort,
			precondition: validPrecondition({
				validation: { status: "pending" },
			}),
		}),
	);
	assert.equal(result.refused, true);
	assert.equal(result.ok, false);
	assert.equal(result.rolledBack, false);
	assert.equal(result.reasons[0]?.code, "validation-unvalidated");
	assert.deepEqual(
		result.facts.map((f) => f.type),
		[CUTOVER_EVENTS.Refused],
	);
	assert.deepEqual(applied, [], "a refused cutover must never touch the port");
});

test("a TTL that was not lowered below the previous value refuses the cutover", async () => {
	const result = await executeRoutingCutover(
		cutoverOptions({
			precondition: validPrecondition({
				ttl: {
					previousTtlSeconds: 300,
					loweredTtlSeconds: 300,
					waitedSeconds: 300,
				},
			}),
		}),
	);
	assert.equal(result.refused, true);
	assert.equal(result.reasons[0]?.code, "ttl-not-lowered");
});

test("an un-waited previous TTL refuses the cutover (resolver caches still hold the old record)", async () => {
	const result = await executeRoutingCutover(
		cutoverOptions({
			precondition: validPrecondition({
				ttl: {
					previousTtlSeconds: 300,
					loweredTtlSeconds: 30,
					waitedSeconds: 120,
				},
			}),
		}),
	);
	assert.equal(result.refused, true);
	assert.equal(result.reasons[0]?.code, "ttl-wait-incomplete");
});

test("a stale incumbent plan refuses the cutover (live-zone precondition)", async () => {
	const result = await executeRoutingCutover(
		cutoverOptions({
			precondition: validPrecondition({
				// SAFETY: assertion required at this I/O or test boundary.
				incumbentPlanId: "plan:checkout:never-applied" as RoutingPlanId,
				incumbentPlan: {
					...INCUMBENT_PLAN,
					// SAFETY: a deliberately valid but unobserved plan identity exercises refusal.
					planId: "plan:checkout:never-applied" as RoutingPlanId,
				},
			}),
		}),
	);
	assert.equal(result.refused, true);
	assert.equal(result.reasons[0]?.code, "incumbent-not-live");
});

test("a satisfied precondition emits TtlLowered with the effective RTO, then completes the ramp", async () => {
	const port = seededSimplePort();
	// Seed the incumbent so port.status reports it active.
	const seed = synthesizeRoutingPlan({
		topology: {
			...TOPOLOGY,
			backends: [
				{ id: "backend:a", service: "checkout", healthy: true, weight: 100 },
			],
		},
		policyDecision: policyDecision(),
		planId: "plan:checkout:incumbent",
		weightStrategy: "static",
	});
	assert.equal(seed.kind, "plan");
	if (seed.kind !== "plan") return;
	await port.apply(seed.plan);

	const result = await executeRoutingCutover(
		cutoverOptions({
			port,
			precondition: validPrecondition({
				incumbentPlanId: seed.plan.planId,
				incumbentPlan: seed.plan,
			}),
		}),
	);
	assert.equal(result.ok, true);
	assert.equal(result.cutover, true);
	assert.deepEqual(
		result.facts.map((f) => f.type),
		[
			CUTOVER_EVENTS.TtlLowered,
			CUTOVER_EVENTS.Started,
			CUTOVER_EVENTS.ApplyRequested,
			"contract.EffectInvoked",
			CUTOVER_EVENTS.Observed,
			CUTOVER_EVENTS.RampAdvanced,
			CUTOVER_EVENTS.ApplyRequested,
			"contract.EffectInvoked",
			CUTOVER_EVENTS.Observed,
			CUTOVER_EVENTS.RampAdvanced,
			CUTOVER_EVENTS.ApplyRequested,
			"contract.EffectInvoked",
			CUTOVER_EVENTS.Observed,
			CUTOVER_EVENTS.RampAdvanced,
			CUTOVER_EVENTS.RoutingChanged,
		],
	);
	const ttlFact = result.facts[0];
	if (ttlFact === undefined) throw new Error("missing ttl fact");
	if (!isJsonObject(ttlFact.data)) throw new Error("ttl fact data");
	assert.equal(ttlFact.data.effectiveRtoSeconds, VALID_TTL.previousTtlSeconds);
	const startFact = result.facts[1];
	if (startFact === undefined) throw new Error("missing start fact");
	if (!isJsonObject(startFact.data)) throw new Error("start fact data");
	assert.equal(startFact.data.validationChangeId, "change-1");
});

test("hysteresis: one health flap below the threshold holds and re-probes instead of rolling back", async () => {
	let probes = 0;
	const result = await executeRoutingCutover(
		cutoverOptions({
			consecutiveFailuresToRollback: 2,
			healthGate: ({ percent }) => {
				probes += 1;
				// Single flap at 50%; healthy on the re-probe.
				return !(percent === 50 && probes === 2);
			},
		}),
	);
	assert.equal(result.ok, true);
	assert.equal(result.rolledBack, false);
	assert.equal(probes, 4, "50% must be probed twice (flap, then recovery)");
	assert.equal(
		result.facts.filter((f) => f.type === CUTOVER_EVENTS.RampAdvanced).length,
		3,
	);
});

test("hysteresis: consecutive failures at the threshold roll back with the streak in the reason", async () => {
	const result = await executeRoutingCutover(
		cutoverOptions({
			consecutiveFailuresToRollback: 2,
			healthGate: ({ percent }) => percent < 50,
		}),
	);
	assert.equal(result.rolledBack, true);
	assert.equal(result.refused, false);
	assert.equal(result.reasons[0]?.code, "health-gate-failed");
	assert.match(
		// SAFETY: assertion required at this I/O or test boundary.
		(result.reasons[0] as { message: string }).message,
		/2 consecutive/,
	);
	assert.equal(
		result.facts[result.facts.length - 1]?.type,
		CUTOVER_EVENTS.RolledBack,
	);
});

test("an invalid ramp shape refuses (domain.CutoverRefused) rather than reporting a rollback", async () => {
	const result = await executeRoutingCutover(
		cutoverOptions({ rampSteps: [50, 10, 100] }),
	);
	assert.equal(result.refused, true);
	assert.equal(result.rolledBack, false);
	assert.deepEqual(
		result.facts.map((f) => f.type),
		[CUTOVER_EVENTS.Refused],
	);
});
