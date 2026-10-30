import assert from "node:assert/strict";
import { createSimpleTrafficRouting } from "@hobo/connectivity";
import {
	allowDecision,
	parseMinAvailabilitySpec,
	parseResiliencySpec,
	parseTenantId,
	type RoutingPlan,
	type TrafficRoutingPort,
} from "@hobo/core";
import { test } from "vitest";
import { createRoutingControlLoop } from "../src/traffic-routing/control-loop.js";
import {
	type CutoverHealthGate,
	executeRoutingCutover,
	type RoutingCutoverOptions,
} from "../src/traffic-routing/cutover.js";
import {
	type RoutingTopology,
	synthesizeRoutingPlan,
} from "../src/traffic-routing/synthesize.js";

const tenantId = parseTenantId("tenant-hardening");
const policyDecision = allowDecision("routing-hardening", {
	subject: { identity: "router", tenantId, tags: [] },
	action: "routing.plan",
	resource: { kind: "service", id: "checkout", tenantId },
});
const topology: RoutingTopology = {
	service: "checkout",
	tenantId,
	stationId: "station:prod",
	costRouting: "stateless",
	backends: [
		{ id: "a", service: "checkout", healthy: true, weight: 100 },
		{ id: "b", service: "checkout", healthy: true, weight: 1 },
	],
};
const costModel = [
	{ backendId: "a", listUnitCost: 0.05 },
	{ backendId: "b", listUnitCost: 0.01 },
];
const signal = {
	kind: "budget" as const,
	fact: { type: "budget.ThresholdCrossed", data: { tenantId } },
};
const prior = synthesizeRoutingPlan({
	topology: {
		...topology,
		backends: topology.backends
			.filter((b) => b.id === "a")
			.map((b) => ({ ...b, weight: 100 })),
	},
	policyDecision,
	planId: "plan:checkout:incumbent",
	weightStrategy: "static",
});
if (prior.kind !== "plan") throw new Error("invalid source fixture");
const incumbentPlan = prior.plan;
function seededSimplePort() {
	const port = createSimpleTrafficRouting();
	void port.apply(incumbentPlan);
	return port;
}
const precondition = {
	validation: { status: "validated" },
	mechanism: "weighted" as const,
	incumbentPlanId: incumbentPlan.planId,
	incumbentPlan,
};
const supervisor = () => ({
	ledgerView: () => ({
		view: "CreditLedgerView" as const,
		seq: 0,
		accounts: [],
	}),
	persistState: async () => {},
	beforeApply: async () => {},
	healthGate: () => true,
});
const loopOptions = () => ({
	...supervisor(),
	topology,
	policyDecision,
	costModel,
	port: seededSimplePort(),
	stability: { cooldownSeconds: 60 },
	incumbentBackendId: "a",
});
const opts = (
	patch: Partial<RoutingCutoverOptions> = {},
): RoutingCutoverOptions => ({
	topology,
	policyDecision,
	port: seededSimplePort(),
	fromBackendId: "a",
	toBackendId: "b",
	precondition,
	healthGate: () => true,
	restorationHealthGate: () => true,
	beforeApply: async () => {},
	...patch,
});
function trackingPort() {
	const original = seededSimplePort();
	const plans: RoutingPlan[] = [];
	return {
		plans,
		port: {
			...original,
			status: original.status.bind(original),
			apply: async (plan: RoutingPlan) => {
				plans.push(plan);
				return original.apply(plan);
			},
		},
	};
}

test("an infeasible final availability shape refuses before the first provider write", async () => {
	const { plans, port } = trackingPort();
	const result = await executeRoutingCutover(
		opts({
			port,
			availability: parseMinAvailabilitySpec({ minHealthyBackends: 2 }),
		}),
	);
	assert.equal(result.refused, true);
	assert.equal(result.reasons[0]?.code, "final-constraints-unsatisfied");
	assert.equal(plans.length, 0);
});
test("availability and resiliency survive every successful ramp", async () => {
	// Contract-backed fixture models an adapter supporting these constraints.
	// The simple weight-only adapter intentionally refuses those guarantees.
	const plans: RoutingPlan[] = [];
	const port: TrafficRoutingPort = {
		provider: "other",
		apply: async (plan) => {
			plans.push(plan);
			return {
				planId: plan.planId,
				provider: "other",
				realized: "full",
				notes: [],
			};
		},
		status: async (planId) =>
			planId === incumbentPlan.planId ||
			plans.some((plan) => plan.planId === planId)
				? { planId, active: true, realized: "full", notes: [] }
				: null,
	};
	const availability = parseMinAvailabilitySpec({ minHealthyBackends: 1 });
	const resiliency = parseResiliencySpec({ timeoutMs: 1000, retries: 2 });
	const result = await executeRoutingCutover(
		opts({ port, availability, resiliency }),
	);
	assert.equal(result.ok, true);
	for (const plan of plans) {
		assert.deepEqual(plan.intent.availability, availability);
		assert.deepEqual(plan.intent.resiliency, resiliency);
	}
});
test("missing readiness, health or financial evidence never moves traffic", async () => {
	const patches = [
		{ precondition: undefined },
		{ healthGate: undefined },
		{ beforeApply: undefined },
	];
	for (const patch of patches) {
		const { plans, port } = trackingPort();
		const result = await executeRoutingCutover(opts({ ...patch, port }));
		assert.equal(result.refused, true);
		assert.equal(plans.length, 0);
	}
});
test("DNS requires TTL evidence while weighted routing does not invent it", async () => {
	const dns = await executeRoutingCutover(
		opts({
			precondition: { validation: { status: "validated" }, mechanism: "dns" },
		}),
	);
	assert.equal(dns.reasons[0]?.code, "ttl-missing");
	assert.equal((await executeRoutingCutover(opts())).ok, true);
});
test("failed restoration remains pending and never emits RolledBack", async () => {
	const original = seededSimplePort();
	let calls = 0;
	const port: TrafficRoutingPort = {
		provider: original.provider,
		status: original.status.bind(original),
		apply: async (plan) => {
			calls++;
			return calls === 1
				? original.apply(plan)
				: {
						planId: plan.planId,
						provider: original.provider,
						realized: "none",
						notes: ["not restored"],
					};
		},
	};
	const result = await executeRoutingCutover(
		opts({ port, healthGate: () => false }),
	);
	assert.equal(result.recoveryPending, true);
	assert.equal(result.rolledBack, false);
	assert.equal(
		result.facts.some((f) => f.type === "domain.RolledBack"),
		false,
	);
	assert.equal(calls, 2);
});
test("ambiguous writes are attempted once and require reconciliation", async () => {
	let calls = 0;
	const original = seededSimplePort();
	const port: TrafficRoutingPort = {
		provider: original.provider,
		status: original.status.bind(original),
		apply: async () => {
			calls++;
			throw new Error("response lost");
		},
	};
	const result = await executeRoutingCutover(opts({ port }));
	assert.equal(result.recoveryPending, true);
	assert.equal(result.rolledBack, false);
	assert.equal(calls, 1);
	assert.equal(
		result.facts.some((f) => f.type === "resilience.Terminal"),
		true,
	);
});
test("fresh evidence covers the declared observation interval", async () => {
	let ms = Date.parse("2026-10-29T12:00:00Z");
	let sample = 0;
	const result = await executeRoutingCutover(
		opts({
			clock: () => new Date(ms).toISOString(),
			minObservationSeconds: 5,
			healthGate: ({ backendId, plan }) => {
				ms += 5000;
				return {
					healthy: true,
					observedAt: new Date(ms).toISOString(),
					observationId: `probe-${++sample}`,
					backendId,
					planId: plan.planId,
				};
			},
		}),
	);
	assert.equal(result.ok, true);
	const stale = await executeRoutingCutover(
		opts({
			clock: () => new Date(ms).toISOString(),
			minObservationSeconds: 5,
			healthGate: ({ backendId, plan }) => ({
				healthy: true,
				backendId,
				planId: plan.planId,
				observedAt: new Date(ms).toISOString(),
				observationId: "old",
			}),
		}),
	);
	assert.equal(stale.recoveryPending, true);
	assert.equal(stale.reasons[0]?.code, "health-evidence-stale");
});
for (const delayAt of ["authorization", "native-apply"] as const) {
	test(`${delayAt} latency cannot satisfy a ramp observation interval`, async () => {
		let ms = Date.parse("2026-10-29T12:00:00Z");
		let writes = 0;
		const original = seededSimplePort();
		const port: TrafficRoutingPort = {
			provider: original.provider,
			status: original.status.bind(original),
			apply: async (plan) => {
				writes++;
				if (delayAt === "native-apply") ms += 60_000;
				return original.apply(plan);
			},
		};
		const result = await executeRoutingCutover(
			opts({
				port,
				clock: () => new Date(ms).toISOString(),
				rampSteps: [100],
				minObservationSeconds: 5,
				beforeApply: async () => {
					if (delayAt === "authorization") ms += 60_000;
				},
				healthGate: ({ backendId, plan }) => ({
					healthy: true,
					backendId,
					planId: plan.planId,
					observationId: "immediate-after-ramp",
					observedAt: new Date(ms).toISOString(),
				}),
			}),
		);
		assert.equal(result.ok, false);
		assert.equal(result.recoveryPending, true);
		assert.equal(result.reasons[0]?.code, "health-evidence-stale");
		assert.equal(writes, 1);
	});
	test(`${delayAt} latency cannot satisfy a restoration observation interval`, async () => {
		let ms = Date.parse("2026-10-29T12:00:00Z");
		let writes = 0;
		const original = seededSimplePort();
		const port: TrafficRoutingPort = {
			provider: original.provider,
			status: original.status.bind(original),
			apply: async (plan) => {
				writes++;
				if (delayAt === "native-apply" && writes === 2) ms += 60_000;
				return original.apply(plan);
			},
		};
		const result = await executeRoutingCutover(
			opts({
				port,
				clock: () => new Date(ms).toISOString(),
				minObservationSeconds: 5,
				beforeApply: async (_plan, phase) => {
					if (delayAt === "authorization" && phase === "restore") ms += 60_000;
				},
				healthGate: ({ backendId, plan }) => {
					ms += 5000;
					return {
						healthy: false,
						backendId,
						planId: plan.planId,
						observationId: "failed-destination-after-dwell",
						observedAt: new Date(ms).toISOString(),
					};
				},
				restorationHealthGate: ({ backendId, plan }) => ({
					healthy: true,
					backendId,
					planId: plan.planId,
					observationId: "immediate-after-restore",
					observedAt: new Date(ms).toISOString(),
				}),
			}),
		);
		assert.equal(result.rolledBack, false);
		assert.equal(result.recoveryPending, true);
		assert.equal(result.reasons[0]?.code, "restoration-health-unconfirmed");
		assert.equal(writes, 2);
	});
}
test("restart starts a fresh dwell after observing an uncertain final apply", async () => {
	let ms = Date.parse("2026-10-29T12:00:00Z");
	let writes = 0;
	let sample = 0;
	const original = seededSimplePort();
	const port: TrafficRoutingPort = {
		provider: original.provider,
		status: original.status.bind(original),
		apply: async (plan) => {
			writes++;
			await original.apply(plan);
			throw new Error("successful apply acknowledgement lost");
		},
	};
	const healthGate: CutoverHealthGate = ({ backendId, plan }) => ({
		healthy: true,
		backendId,
		planId: plan.planId,
		observationId: `resumed-${++sample}`,
		observedAt: new Date(ms).toISOString(),
	});
	const cutover = {
		precondition,
		rampSteps: [100],
		minObservationSeconds: 5,
		healthGate,
		restorationHealthGate: () => true,
	};
	const first = createRoutingControlLoop({
		...loopOptions(),
		port,
		cutover,
		clock: () => new Date(ms).toISOString(),
		beforeApply: async () => {
			ms += 60_000;
		},
	});
	assert.equal(
		(await first.handleSignal(signal)).action,
		"reconciliation-required",
	);
	const resumed = createRoutingControlLoop({
		...loopOptions(),
		port,
		cutover,
		clock: () => new Date(ms).toISOString(),
		initialState: first.snapshot(),
	});
	assert.equal(
		(await resumed.reconcilePending()).action,
		"reconciliation-required",
	);
	assert.equal(resumed.incumbent(), "a");
	assert.equal(resumed.snapshot().pendingStartedAtMs, ms);
	ms += 5000;
	assert.equal((await resumed.reconcilePending()).action, "noop");
	assert.equal(resumed.incumbent(), "b");
	assert.equal(writes, 1);
});
test("health observation errors preserve applied state as uncertain", async () => {
	const result = await executeRoutingCutover(
		opts({
			healthGate: () => {
				throw new Error("telemetry unavailable");
			},
		}),
	);
	assert.equal(result.recoveryPending, true);
	assert.equal(result.reasons[0]?.code, "health-outcome-unknown");
});
test("concurrent signals serialize around provider effects", async () => {
	const original = seededSimplePort();
	let applies = 0;
	let release: () => void = () => {};
	const blocked = new Promise<void>((r) => {
		release = r;
	});
	const port: TrafficRoutingPort = {
		provider: original.provider,
		status: original.status.bind(original),
		apply: async (plan) => {
			applies++;
			await blocked;
			return original.apply(plan);
		},
	};
	const loop = createRoutingControlLoop({
		...loopOptions(),
		port,
		stability: {
			cooldownSeconds: 60,
			maxSwapsPerWindow: 1,
			windowSeconds: 3600,
		},
	});
	const first = loop.handleSignal(signal);
	const second = loop.handleSignal(signal);
	await new Promise((r) => setImmediate(r));
	assert.equal(applies, 1);
	release();
	assert.equal((await first).action, "reapplied");
	assert.equal((await second).action, "noop");
	assert.equal(applies, 1);
});
test("unhealthy incumbent can recover during optimization cooldown", async () => {
	let now = "2026-10-29T12:00:00Z";
	const reasons: string[] = [];
	const loop = createRoutingControlLoop({
		...loopOptions(),
		clock: () => now,
		stability: {
			cooldownSeconds: 60,
			maxSwapsPerWindow: 1,
			windowSeconds: 3600,
		},
		beforeApply: async (_plan, _phase, _percent, reason) => {
			reasons.push(reason);
		},
	});
	assert.equal((await loop.handleSignal(signal)).action, "reapplied");
	now = "2026-10-29T12:00:05Z";
	const recovered = await loop.handleSignal({
		kind: "health",
		observations: {
			source: "health",
			backends: [
				{ backendId: "a", healthy: true },
				{ backendId: "b", healthy: false },
			],
		},
	});
	assert.equal(recovered.action, "reapplied");
	assert.equal(loop.incumbent(), "a");
	assert.deepEqual(reasons, ["optimization", "recovery"]);
});
test("restart observes pending final effects without repeating writes", async () => {
	const original = seededSimplePort();
	let applies = 0;
	let permitObservation = false;
	const port: TrafficRoutingPort = {
		provider: original.provider,
		apply: async (plan) => {
			applies++;
			await original.apply(plan);
			throw new Error("response lost");
		},
		status: async (id) => (permitObservation ? original.status(id) : null),
	};
	const first = createRoutingControlLoop({ ...loopOptions(), port });
	assert.equal(
		(await first.handleSignal(signal)).action,
		"reconciliation-required",
	);
	const snapshot = first.snapshot();
	assert.ok(snapshot.pendingPlanId);
	const resumed = createRoutingControlLoop({
		...loopOptions(),
		port,
		initialState: snapshot,
	});
	assert.equal(
		(await resumed.handleSignal(signal)).action,
		"reconciliation-required",
	);
	assert.equal(applies, 1);
	permitObservation = true;
	await resumed.reconcilePending();
	assert.equal(resumed.incumbent(), "b");
	assert.equal(resumed.snapshot().pendingPlanId, "");
	assert.equal(applies, 1);
});
test("snapshot cannot cross tenant or service boundaries", () => {
	const first = createRoutingControlLoop(loopOptions());
	const snapshot = first.snapshot();
	snapshot.tenantId = "other";
	assert.throws(
		() =>
			createRoutingControlLoop({ ...loopOptions(), initialState: snapshot }),
		/scope mismatch/,
	);
});
test("lost persistence fence prevents every external write", async () => {
	const { plans, port } = trackingPort();
	const loop = createRoutingControlLoop({
		...loopOptions(),
		port,
		persistState: async () => {
			throw new Error("fence lost");
		},
	});
	await assert.rejects(loop.handleSignal(signal), /fence lost/);
	assert.equal(plans.length, 0);
});

test("every durable checkpoint advances its CAS version independently of plan revision", async () => {
	let storedVersion = 0;
	const versions: number[] = [];
	const first = createRoutingControlLoop({
		...loopOptions(),
		persistState: async (next, expectedVersion) => {
			assert.equal(expectedVersion, storedVersion);
			assert.equal(next.stateVersion, storedVersion + 1);
			storedVersion = next.stateVersion;
			versions.push(next.stateVersion);
		},
	});
	assert.equal((await first.handleSignal(signal)).action, "reapplied");
	assert.deepEqual(versions, [1, 2, 3]);
	assert.equal(first.revision(), 1);
	assert.equal(first.snapshot().stateVersion, 3);
});
test("single-writer and undeclared topologies cannot price-reroute", async () => {
	for (const declaration of [undefined, "single-writer"] as const) {
		const { plans, port } = trackingPort();
		const candidate = { ...topology };
		if (declaration === undefined) delete candidate.costRouting;
		else candidate.costRouting = declaration;
		const loop = createRoutingControlLoop({
			...loopOptions(),
			topology: candidate,
			port,
		});
		assert.equal((await loop.handleSignal(signal)).action, "denied");
		assert.equal(plans.length, 0);
	}
});
test("budget shifts require durable financial supervisor capabilities", async () => {
	const { plans, port } = trackingPort();
	const loop = createRoutingControlLoop({
		topology,
		policyDecision,
		costModel,
		port,
		stability: { cooldownSeconds: 60 },
		incumbentBackendId: "a",
	});
	const result = await loop.handleSignal(signal);
	assert.equal(result.action, "denied");
	assert.equal(
		result.action === "denied" && result.reasons[0]?.code,
		"financial-supervisor-required",
	);
	assert.equal(plans.length, 0);
});
test("foreign budget signals cannot initiate another tenant's move", async () => {
	const { plans, port } = trackingPort();
	const loop = createRoutingControlLoop({ ...loopOptions(), port });
	const result = await loop.handleSignal({
		kind: "budget",
		fact: { type: "budget.ThresholdCrossed", data: { tenantId: "foreign" } },
	});
	assert.equal(result.action, "denied");
	assert.equal(plans.length, 0);
});

test("protected recovery headroom remains usable after ordinary budget exhaustion", async () => {
	const accounts = (budgetCap: number) =>
		["a", "b"].map((providerId) => ({
			providerId,
			dimension: "traffic.requests",
			listUnitCost: providerId === "a" ? 0.05 : 0.01,
			freeHeadroom: 0,
			budgetCap,
			spendToDate: 0,
			concurrencyHeadroom: 1,
		}));
	const loop = createRoutingControlLoop({
		...loopOptions(),
		incumbentBackendId: "b",
		ledgerView: () => ({
			view: "CreditLedgerView",
			seq: 1,
			accounts: accounts(0),
		}),
		recoveryLedgerView: () => ({
			view: "CreditLedgerView",
			seq: 2,
			accounts: accounts(10),
		}),
	});
	const result = await loop.handleSignal({
		kind: "health",
		observations: {
			source: "health",
			backends: [
				{ backendId: "a", healthy: true },
				{ backendId: "b", healthy: false },
			],
		},
	});
	assert.equal(result.action, "reapplied");
	assert.equal(loop.incumbent(), "a");
});

test("source outage during compensation cannot be reported as restored", async () => {
	const result = await executeRoutingCutover(
		opts({
			healthGate: () => false,
			restorationHealthGate: ({ phase, backendId }) => {
				assert.equal(phase, "restore");
				assert.equal(backendId, "a");
				return false;
			},
		}),
	);
	assert.equal(result.recoveryPending, true);
	assert.equal(result.rolledBack, false);
	assert.equal(result.reasons[0]?.code, "restoration-health-unconfirmed");
});

test("compensation restores exact approved source artifact and excludes failed candidates", async () => {
	const { plans, port } = trackingPort();
	const result = await executeRoutingCutover(
		opts({ port, healthGate: () => false }),
	);
	assert.equal(result.rolledBack, true);
	const restored = plans.at(-1);
	assert.ok(restored);
	assert.deepEqual(restored.backends, incumbentPlan.backends);
	assert.deepEqual(restored.intent, incumbentPlan.intent);
	assert.equal(
		restored.backends.some((backend) => backend.id === "b"),
		false,
	);
});
test("missing or foreign incumbent artifact refuses without side effects", async () => {
	for (const supplied of [
		undefined,
		{ ...incumbentPlan, stationId: "station:foreign" },
	]) {
		const { plans, port } = trackingPort();
		const result = await executeRoutingCutover(
			opts({
				port,
				precondition: { ...precondition, incumbentPlan: supplied },
			}),
		);
		assert.equal(result.refused, true);
		assert.equal(plans.length, 0);
	}
});
test("repeated health probes do not repeat the same ramp mutation", async () => {
	const { plans, port } = trackingPort();
	let probes = 0;
	const result = await executeRoutingCutover(
		opts({
			port,
			consecutiveFailuresToRollback: 2,
			healthGate: ({ percent }) => {
				probes++;
				return !(percent === 50 && probes === 2);
			},
		}),
	);
	assert.equal(result.ok, true);
	assert.equal(probes, 4);
	assert.deepEqual(
		plans.map((plan) => plan.planId),
		[
			"cutover:checkout:b:p10",
			"cutover:checkout:b:p50",
			"cutover:checkout:b:p100",
		],
	);
});
test("restart cannot turn final routing status into healthy service without fresh evidence", async () => {
	const original = seededSimplePort();
	let writes = 0;
	const port: TrafficRoutingPort = {
		provider: original.provider,
		status: original.status.bind(original),
		apply: async (plan) => {
			writes++;
			await original.apply(plan);
			throw new Error("response lost");
		},
	};
	const first = createRoutingControlLoop({ ...loopOptions(), port });
	assert.equal(
		(await first.handleSignal(signal)).action,
		"reconciliation-required",
	);
	const resumed = createRoutingControlLoop({
		...loopOptions(),
		port,
		initialState: first.snapshot(),
		healthGate: () => false,
	});
	assert.equal(
		(await resumed.reconcilePending()).action,
		"reconciliation-required",
	);
	assert.equal(resumed.incumbent(), "a");
	assert.ok(resumed.snapshot().pendingPlanId);
	assert.equal(writes, 1);
});
test("budget-invalid incumbent bypasses optimization cooldown", async () => {
	let now = "2026-10-29T12:00:00Z";
	let budgetCap = 100;
	let priceA = 0.05;
	let priceB = 0.01;
	const ledgerView = () => ({
		view: "CreditLedgerView" as const,
		seq: 1,
		accounts: [
			{
				providerId: "a",
				dimension: "traffic.requests",
				listUnitCost: priceA,
				freeHeadroom: 0,
				budgetCap: 100,
				spendToDate: 0,
			},
			{
				providerId: "b",
				dimension: "traffic.requests",
				listUnitCost: priceB,
				freeHeadroom: 0,
				budgetCap,
				spendToDate: 0,
			},
		],
	});
	const loop = createRoutingControlLoop({
		...loopOptions(),
		clock: () => now,
		ledgerView,
	});
	assert.equal((await loop.handleSignal(signal)).action, "reapplied");
	now = "2026-10-29T12:00:05Z";
	budgetCap = 0;
	priceA = 0.01;
	priceB = 0.05;
	assert.equal((await loop.handleSignal(signal)).action, "reapplied");
	assert.equal(loop.incumbent(), "a");
});

test("foreign incumbent status cannot authorize a cutover", async () => {
	const { plans, port } = trackingPort();
	port.status = async () => ({
		planId: "plan:foreign",
		active: true,
		realized: "full",
		notes: [],
	});
	const result = await executeRoutingCutover(opts({ port }));
	assert.equal(result.refused, true);
	assert.equal(plans.length, 0);
});

test("foreign mutation acknowledgements cannot advance a ramp", async () => {
	const original = seededSimplePort();
	let writes = 0;
	const result = await executeRoutingCutover(
		opts({
			port: {
				...original,
				status: original.status.bind(original),
				apply: async (plan) => {
					writes++;
					await original.apply(plan);
					return {
						planId: "plan:foreign",
						provider: original.provider,
						realized: "full",
						notes: [],
					};
				},
			},
		}),
	);
	assert.equal(result.recoveryPending, true);
	assert.equal(result.ok, false);
	assert.equal(writes, 1);
});

test("restart rejects status for another plan and expired target health", async () => {
	const original = seededSimplePort();
	let now = Date.parse("2026-10-29T12:00:00Z");
	let foreignStatus = false;
	let staleHealth = false;
	const port: TrafficRoutingPort = {
		provider: original.provider,
		status: async (id) => {
			const status = await original.status(id);
			return status && foreignStatus
				? { ...status, planId: "plan:foreign" }
				: status;
		},
		apply: async (plan) => {
			await original.apply(plan);
			throw new Error("response lost");
		},
	};
	const first = createRoutingControlLoop({
		...loopOptions(),
		port,
		clock: () => new Date(now).toISOString(),
	});
	assert.equal(
		(await first.handleSignal(signal)).action,
		"reconciliation-required",
	);
	const snapshot = first.snapshot();
	now += 60_000;
	const resumed = createRoutingControlLoop({
		...loopOptions(),
		port,
		initialState: snapshot,
		clock: () => new Date(now).toISOString(),
		healthGate: ({ backendId, plan }) => ({
			healthy: true,
			backendId,
			planId: plan.planId,
			observationId: "old-post-apply",
			observedAt: new Date(
				staleHealth ? snapshot.pendingStartedAtMs : now,
			).toISOString(),
		}),
	});
	foreignStatus = true;
	assert.equal(
		(await resumed.reconcilePending()).action,
		"reconciliation-required",
	);
	foreignStatus = false;
	staleHealth = true;
	assert.equal(
		(await resumed.reconcilePending()).action,
		"reconciliation-required",
	);
	assert.equal(resumed.incumbent(), "a");
	assert.ok(resumed.snapshot().pendingPlanId);
});
