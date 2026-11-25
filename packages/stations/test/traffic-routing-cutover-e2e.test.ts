import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSimpleTrafficRouting } from "@hobo/connectivity";
import {
	allowDecision,
	type PolicyDecision,
	parseTenantId,
	type RoutingPlan,
	type RoutingPlanId,
} from "@hobo/core";
import { afterAll, beforeAll, test } from "vitest";

import {
	createRoutingControlLoop,
	ROUTING_LOOP_EVENTS,
} from "../src/traffic-routing/control-loop.js";
import { CUTOVER_EVENTS } from "../src/traffic-routing/cutover.js";
import {
	type RoutingTopology,
	synthesizeRoutingPlan,
} from "../src/traffic-routing/synthesize.js";

const tenantId = parseTenantId("tenant-a");

function policyDecision(): PolicyDecision {
	return allowDecision("test-policy", {
		subject: { identity: "router", tenantId, tags: [] },
		action: "routing.plan",
		resource: { kind: "service", id: "site", tenantId },
	});
}

function listen(server: Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${port}`);
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let backendA: Server;
let backendB: Server;
let proxy: Server;
let backendAUrl: string;
let backendBUrl: string;
let proxyUrl: string;

const port = createSimpleTrafficRouting();
let activePlanId: RoutingPlanId | undefined;
const routedPort = {
	...port,
	apply: async (plan: RoutingPlan) => {
		const result = await port.apply(plan);
		activePlanId = plan.planId;
		return result;
	},
	status: port.status.bind(port),
	revoke: port.revoke.bind(port),
	select: port.select.bind(port),
};

beforeAll(async () => {
	backendA = createServer((_req, res) => res.end("A"));
	backendB = createServer((_req, res) => res.end("B"));
	backendAUrl = await listen(backendA);
	backendBUrl = await listen(backendB);

	proxy = createServer(async (req, res) => {
		try {
			if (!activePlanId) throw new Error("no active routing plan");
			const backend = port.select(activePlanId, req.url ?? "/");
			if (!backend?.endpoint) throw new Error("no routable backend selected");
			const upstream = await fetch(backend.endpoint);
			res.statusCode = upstream.status;
			res.end(await upstream.text());
		} catch (error) {
			res.statusCode = 502;
			res.end(String(error));
		}
	});
	proxyUrl = await listen(proxy);
});

afterAll(async () => {
	for (const server of [proxy, backendA, backendB]) {
		await new Promise((resolve) => server.close(resolve));
	}
});

function topology(): RoutingTopology {
	return {
		service: "site",
		tenantId,
		stationId: "station:prod",
		costRouting: "stateless",
		backends: [
			{
				id: "backend:a",
				service: "site",
				endpoint: backendAUrl,
				healthy: true,
			},
			{
				id: "backend:b",
				service: "site",
				endpoint: backendBUrl,
				healthy: true,
			},
		],
	};
}

async function seedIncumbentPlan(backendId: string, planId: string) {
	const seedTopology = topology();
	const synthesis = synthesizeRoutingPlan({
		topology: {
			...seedTopology,
			backends: seedTopology.backends
				.filter((backend) => backend.id === backendId)
				.map((backend) => ({ ...backend, weight: 100 })),
		},
		policyDecision: policyDecision(),
		planId,
		weightStrategy: "static",
	});
	assert.equal(synthesis.kind, "plan");
	if (synthesis.kind !== "plan") throw new Error("seed plan denied");
	await routedPort.apply(synthesis.plan);
	return synthesis.plan;
}

const COST_MODEL = [
	{ backendId: "backend:a", listUnitCost: 0.05 },
	{ backendId: "backend:b", listUnitCost: 0.01 },
];

const BUDGET_SIGNAL = {
	kind: "budget" as const,
	fact: {
		type: "budget.ThresholdCrossed",
		data: { tenantId: "tenant-a", thresholdFraction: 0.8, cycle: 1 },
	},
};

interface TrafficLog {
	total: number;
	failed: number;
	bodies: string[];
}

interface TrafficGenerator {
	stop: (minRequests?: number) => Promise<TrafficLog>;
}

function startTrafficGenerator(): TrafficGenerator {
	const log: TrafficLog = { total: 0, failed: 0, bodies: [] };
	let running = true;
	const worker = (async () => {
		let n = 0;
		while (running) {
			n += 1;
			try {
				const response = await fetch(`${proxyUrl}/req-${n}-${Math.random()}`);
				const body = await response.text();
				log.total += 1;
				if (response.status !== 200) log.failed += 1;
				else log.bodies.push(body);
			} catch {
				log.total += 1;
				log.failed += 1;
			}
			await sleep(2);
		}
	})();
	return {
		stop: async (minRequests = 0) => {
			const deadline = Date.now() + 5_000;
			while (log.total < minRequests && Date.now() < deadline) {
				await sleep(2);
			}
			running = false;
			await worker;
			return log;
		},
	};
}

test("milestone: budget-pressured swap from A to B with zero failed requests across the ramp", async () => {
	const incumbentPlan = await seedIncumbentPlan(
		"backend:a",
		"plan:site:seed-a",
	);

	const facts: string[] = [];
	const loop = createRoutingControlLoop({
		ledgerView: () => ({ view: "CreditLedgerView", seq: 0, accounts: [] }),
		persistState: async () => {},
		beforeApply: async () => {},
		topology: topology(),
		policyDecision: policyDecision(),
		costModel: COST_MODEL,
		port: routedPort,
		stability: { cooldownSeconds: 60 },
		incumbentBackendId: "backend:a",
		units: 100,
		cutover: {
			restorationHealthGate: async () =>
				(await fetch(backendAUrl)).status === 200,
			precondition: {
				validation: { status: "validated" },
				mechanism: "weighted",
				incumbentPlanId: incumbentPlan.planId,
				incumbentPlan,
			},
			rampSteps: [10, 50, 100],
			healthGate: async () => {
				await sleep(40);
				const probe = await fetch(backendBUrl);
				return probe.status === 200;
			},
		},
		onFact: (fact) => facts.push(fact.type),
	});

	const traffic = startTrafficGenerator();
	await sleep(30);

	const outcome = await loop.handleSignal(BUDGET_SIGNAL);

	await sleep(30);
	const log = await traffic.stop(11);

	assert.equal(outcome.action, "reapplied");
	assert.equal(loop.incumbent(), "backend:b");

	assert.equal(
		log.failed,
		0,
		`expected zero failed requests, saw ${log.failed}/${log.total}`,
	);
	assert.ok(
		log.total > 10,
		`traffic generator only sent ${log.total} requests`,
	);
	assert.ok(log.bodies.includes("A"), "no request reached the incumbent");
	assert.ok(log.bodies.includes("B"), "no request reached the target");

	assert.deepEqual(facts, [
		"dispatch.Decided",
		ROUTING_LOOP_EVENTS.ReplanProposed,
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
		ROUTING_LOOP_EVENTS.Reapplied,
	]);

	for (let i = 0; i < 10; i += 1) {
		const response = await fetch(`${proxyUrl}/post-cutover-${i}`);
		assert.equal(await response.text(), "B");
	}
});

test("milestone: health-gate failure at 50% rolls back automatically with zero failed requests", async () => {
	const incumbentPlan = await seedIncumbentPlan(
		"backend:a",
		"plan:site:seed-a-rollback",
	);

	const facts: string[] = [];
	const loop = createRoutingControlLoop({
		ledgerView: () => ({ view: "CreditLedgerView", seq: 0, accounts: [] }),
		persistState: async () => {},
		beforeApply: async () => {},
		topology: topology(),
		policyDecision: policyDecision(),
		costModel: COST_MODEL,
		port: routedPort,
		stability: { cooldownSeconds: 60 },
		incumbentBackendId: "backend:a",
		units: 100,
		cutover: {
			restorationHealthGate: async () =>
				(await fetch(backendAUrl)).status === 200,
			precondition: {
				validation: { status: "validated" },
				mechanism: "weighted",
				incumbentPlanId: incumbentPlan.planId,
				incumbentPlan,
			},
			rampSteps: [10, 50, 100],
			healthGate: async ({ percent }) => {
				await sleep(40);
				return percent < 50;
			},
		},
		onFact: (fact) => facts.push(fact.type),
	});

	const traffic = startTrafficGenerator();
	await sleep(30);

	const outcome = await loop.handleSignal(BUDGET_SIGNAL);

	await sleep(30);
	const log = await traffic.stop();

	assert.equal(outcome.action, "rolled-back");
	assert.equal(
		outcome.action === "rolled-back" && outcome.reasons[0]?.code,
		"health-gate-failed",
	);
	assert.equal(loop.incumbent(), "backend:a");
	assert.equal(
		log.failed,
		0,
		`expected zero failed requests, saw ${log.failed}/${log.total}`,
	);

	assert.deepEqual(facts, [
		"dispatch.Decided",
		ROUTING_LOOP_EVENTS.ReplanProposed,
		CUTOVER_EVENTS.Started,
		CUTOVER_EVENTS.ApplyRequested,
		"contract.EffectInvoked",
		CUTOVER_EVENTS.Observed,
		CUTOVER_EVENTS.RampAdvanced,
		CUTOVER_EVENTS.ApplyRequested,
		"contract.EffectInvoked",
		CUTOVER_EVENTS.Observed,
		CUTOVER_EVENTS.ApplyRequested,
		"contract.EffectInvoked",
		CUTOVER_EVENTS.Observed,
		CUTOVER_EVENTS.RolledBack,
	]);

	for (let i = 0; i < 10; i += 1) {
		const response = await fetch(`${proxyUrl}/post-rollback-${i}`);
		assert.equal(await response.text(), "A");
	}
});
