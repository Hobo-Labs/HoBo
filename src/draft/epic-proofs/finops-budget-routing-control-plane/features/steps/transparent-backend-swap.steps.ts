/**
 * Executable step definitions for transparent-backend-swap.feature.
 *
 * This is the acceptance proof of the platform vision statement: a budget
 * signal drives a backend swap behind a live loopback HTTP proxy while a
 * continuous request stream observes zero failures. It exercises the PROMOTED
 * production slices end to end — @hobo/dispatcher (dispatch.Decided),
 * @hobo/stations control loop + progressive cutover, @hobo/connectivity
 * simple adapter — with no live cloud providers (loopback servers only).
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { After, Given, Then, When } from "@cucumber/cucumber";

import { createSimpleTrafficRouting } from "../../../../../../packages/connectivity/src/index.js";
import {
	allowDecision,
	parseTenantId,
	type PolicyDecision,
	type RoutingPlan,
	type RoutingPlanId,
} from "../../../../../../packages/core/src/index.js";
import {
	createRoutingControlLoop,
	CUTOVER_EVENTS,
	type RoutingControlLoop,
	type RoutingControlOutcome,
	ROUTING_LOOP_EVENTS,
	type RoutingTopology,
	synthesizeRoutingPlan,
} from "../../../../../../packages/stations/src/index.js";

const tenantId = parseTenantId("tenant-a");

function policyDecision(): PolicyDecision {
	return allowDecision("behavior-policy", {
		subject: { identity: "router", tenantId, tags: [] },
		action: "routing.plan",
		resource: { kind: "service", id: "site", tenantId },
	});
}

function listen(server: Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			// SAFETY: assertion to `er.address() as AddressInfo; ` is required at this boundary.
			const { port } = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${port}`);
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TrafficLog {
	total: number;
	failed: number;
	bodies: string[];
}

interface TrafficStream {
	stop: () => Promise<TrafficLog>;
	waitForAdditional: (count: number) => Promise<void>;
}

interface SwapWorld {
	servers: Server[];
	backendAUrl?: string;
	backendBUrl?: string;
	proxyUrl?: string;
	port?: ReturnType<typeof createSimpleTrafficRouting>;
	routedPort?: ReturnType<typeof createSimpleTrafficRouting>;
	activePlanId?: RoutingPlanId;
	incumbentPlan?: RoutingPlan;
	loop?: RoutingControlLoop;
	outcome?: RoutingControlOutcome;
	facts: string[];
	traffic?: TrafficStream;
	log?: TrafficLog;
	unhealthyAtPercent?: number;
}

const world: SwapWorld = { servers: [], facts: [] };

After(async () => {
	if (world.traffic) {
		await world.traffic.stop();
		world.traffic = undefined;
	}
	for (const server of world.servers) {
		await new Promise((resolve) => server.close(resolve));
	}
	world.servers = [];
	world.facts = [];
	world.outcome = undefined;
	world.loop = undefined;
	world.log = undefined;
	world.activePlanId = undefined;
	world.incumbentPlan = undefined;
	world.unhealthyAtPercent = undefined;
});

function topology(): RoutingTopology {
	assert.ok(world.backendAUrl && world.backendBUrl, "backends not started");
	return {
		service: "site",
		tenantId,
		stationId: "station:prod",
		costRouting: "stateless",
		backends: [
			{
				id: "backend:a",
				service: "site",
				endpoint: world.backendAUrl,
				healthy: true,
			},
			{
				id: "backend:b",
				service: "site",
				endpoint: world.backendBUrl,
				healthy: true,
			},
		],
	};
}

const COST_MODEL = [
	{ backendId: "backend:a", listUnitCost: 0.05 },
	{ backendId: "backend:b", listUnitCost: 0.01 },
];

Given(
	"two live backends behind a routing proxy with the incumbent serving all traffic",
	async () => {
		const backendA = createServer((_req, res) => res.end("A"));
		const backendB = createServer((_req, res) => res.end("B"));
		world.servers.push(backendA, backendB);
		world.backendAUrl = await listen(backendA);
		world.backendBUrl = await listen(backendB);

		const port = createSimpleTrafficRouting();
		world.port = port;
		world.routedPort = {
			...port,
			apply: async (plan: RoutingPlan) => {
				const result = await port.apply(plan);
				world.activePlanId = plan.planId;
				return result;
			},
			status: port.status.bind(port),
			revoke: port.revoke.bind(port),
			select: port.select.bind(port),
		};

		// A real reverse proxy: pick a backend from the ACTIVE routing plan per
		// request; any routing gap surfaces as a 502 the stream will count.
		const proxy = createServer(async (req, res) => {
			try {
				if (!world.activePlanId) throw new Error("no active routing plan");
				const backend = port.select(world.activePlanId, req.url ?? "/");
				if (!backend?.endpoint) throw new Error("no routable backend");
				const upstream = await fetch(backend.endpoint);
				res.statusCode = upstream.status;
				res.end(await upstream.text());
			} catch (error) {
				res.statusCode = 502;
				res.end(String(error));
			}
		});
		world.servers.push(proxy);
		world.proxyUrl = await listen(proxy);

		// Seed 100% of traffic on the incumbent.
		const seedTopology = topology();
		const synthesis = synthesizeRoutingPlan({
			topology: {
				...seedTopology,
				backends: seedTopology.backends
					.filter((backend) => backend.id === "backend:a")
					.map((backend) => ({ ...backend, weight: 100 })),
			},
			policyDecision: policyDecision(),
			planId: "plan:site:behavior-seed",
			weightStrategy: "static",
		});
		assert.equal(synthesis.kind, "plan");
		if (synthesis.kind !== "plan") return;
		world.incumbentPlan = synthesis.plan;
		await world.routedPort.apply(synthesis.plan);
	},
);

Given("a continuous request stream against the proxy", async () => {
	const proxyUrl = world.proxyUrl;
	assert.ok(proxyUrl, "proxy not started");
	const log: TrafficLog = { total: 0, failed: 0, bodies: [] };
	let running = true;
	const worker = (async () => {
		let n = 0;
		while (running) {
			n += 1;
			try {
				const response = await fetch(`${proxyUrl}/req-${n}`);
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
	world.traffic = {
		waitForAdditional: async (count) => {
			const requiredTotal = log.total + count;
			const deadline = Date.now() + 10_000;
			while (log.total < requiredTotal) {
				assert.ok(Date.now() < deadline, `traffic did not reach ${requiredTotal} requests; observed ${log.total}`);
				assert.ok(running, "traffic stopped before the observation interval completed");
				await sleep(2);
			}
		},
		stop: async () => {
			running = false;
			await worker;
			return log;
		},
	};
	await world.traffic.waitForAdditional(5);
});

Given("the target backend will fail its health gate at fifty percent", () => {
	world.unhealthyAtPercent = 50;
});

When("a budget threshold crossing reaches the routing control loop", async () => {
	assert.ok(world.routedPort, "routing port not started");
	assert.ok(world.incumbentPlan, "incumbent artifact not seeded");
	const unhealthyAt = world.unhealthyAtPercent;
	let persistedStateVersion = 0;
	world.loop = createRoutingControlLoop({
		topology: topology(),
		policyDecision: policyDecision(),
		costModel: COST_MODEL,
		port: world.routedPort,
		ledgerView: () => ({
			view: "CreditLedgerView",
			seq: 1,
			accounts: COST_MODEL.map((model) => ({
				providerId: model.backendId,
				dimension: "traffic.requests",
				listUnitCost: model.listUnitCost,
				freeHeadroom: 0,
				budgetCap: 100,
				spendToDate: 0,
				concurrencyHeadroom: 1,
			})),
		}),
		persistState: async (state, expectedStateVersion) => {
			assert.equal(expectedStateVersion, persistedStateVersion, "state persistence is CAS fenced");
			assert.equal(state.stateVersion, persistedStateVersion + 1, "every checkpoint advances the state version");
			persistedStateVersion = state.stateVersion;
		},
		beforeApply: async (plan) => {
			assert.equal(plan.intent.tenantId, tenantId, "mock financial grant is tenant-scoped");
			assert.equal(plan.intent.service, "site", "mock financial grant is deployment-scoped");
		},
		stability: { cooldownSeconds: 60 },
		incumbentBackendId: "backend:a",
		units: 100,
		cutover: {
			precondition: { validation: { status: "validated" }, mechanism: "weighted", incumbentPlanId: world.incumbentPlan.planId, incumbentPlan: world.incumbentPlan },
			restorationHealthGate: async () => {
				assert.ok(world.traffic, "traffic stream not started");
				await world.traffic.waitForAdditional(5);
				assert.ok(world.backendAUrl);
				const probe = await fetch(world.backendAUrl);
				return probe.status === 200 && await probe.text() === "A";
			},
			rampSteps: [10, 50, 100],
			healthGate: async ({ percent }) => {
				// Each applied ramp stays active until actual requests observe it.
				// Elapsed sleeps do not prove a busy concurrent runner sent traffic.
				assert.ok(world.traffic, "traffic stream not started");
				await world.traffic.waitForAdditional(5);
				if (unhealthyAt !== undefined) return percent < unhealthyAt;
				// SAFETY: assertion to `d.backendBUrl as string); ` is required at this boundary.
				const probe = await fetch(world.backendBUrl as string);
				return probe.status === 200;
			},
		},
		onFact: (fact) => world.facts.push(fact.type),
	});
	world.outcome = await world.loop.handleSignal({
		kind: "budget",
		fact: {
			type: "budget.ThresholdCrossed",
			data: { tenantId: "tenant-a", thresholdFraction: 0.8, cycle: 1 },
		},
	});
	assert.ok(world.traffic, "traffic stream not started");
	await world.traffic.waitForAdditional(5);
	world.log = await world.traffic.stop();
	world.traffic = undefined;
});

Then("the control loop reapplies routing onto the cheaper backend", () => {
	assert.equal(world.outcome?.action, "reapplied");
	assert.equal(world.loop?.incumbent(), "backend:b");
});

Then("the control loop rolls back to the incumbent backend", () => {
	assert.equal(world.outcome?.action, "rolled-back");
	assert.equal(world.loop?.incumbent(), "backend:a");
});

Then("no request observed a failure during the swap", () => {
	const log = world.log;
	assert.ok(log, "traffic log missing");
	assert.equal(
		log.failed,
		0,
		`expected zero failed requests, saw ${log.failed}/${log.total}`,
	);
	assert.ok(log.total >= 20, `stream only sent ${log.total} requests`);
});

Then("the fact trace follows the domain cutover saga ladder", () => {
	assert.deepEqual(world.facts, [
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
});

Then("every request after the cutover is served by the new backend", async () => {
	for (let i = 0; i < 10; i += 1) {
		const response = await fetch(`${world.proxyUrl}/post-cutover-${i}`);
		assert.equal(await response.text(), "B");
	}
});

Then(
	"every request after the rollback is served by the incumbent backend",
	async () => {
		for (let i = 0; i < 10; i += 1) {
			const response = await fetch(`${world.proxyUrl}/post-rollback-${i}`);
			assert.equal(await response.text(), "A");
		}
	},
);
