// adapters/traffic.ts: TrafficShifter over the real Station cutover
// (executeRoutingCutover), against an in-memory TrafficRoutingPort.
import {
	allowDecision,
	parseTenantId,
	type ApplyResult,
	type RoutingPlan,
	type RoutingPlanId,
	type RoutingStatus,
	type TrafficRoutingPort,
} from "@hobo/core";
import { type RoutingTopology, synthesizeRoutingPlan } from "@hobo/stations";
import { describe, expect, it } from "vitest";
import {
	type CampRoutingContext,
	createCutoverTrafficShifter,
	cutoverPlanId,
} from "../../src/adapters/traffic.js";
import type { RolloutId } from "../../src/ports.js";
import { stageRoutingPlan } from "../../src/rollout/routing.js";
import { createHarnessRolloutEngine } from "../../src/adapters/harness.js";
import { RolloutStrategy } from "../../src/_generated/cd_pb.js";
import { createRolloutOrchestrator } from "../../src/rollout/orchestrator.js";
import {
	camp,
	clock,
	context,
	FakeApprovals,
	FakeDesired,
	FakeVerification,
	FakeWindows,
	MemoryEventStore,
	MINUTE,
	promotion,
	RecordingTelemetry,
	spec,
	T0,
	TENANT,
} from "./fakes.js";

const tenantId = parseTenantId(TENANT);
const SERVICE = "web";

/** Routing state a provider would hold: the last fully realized plan is active. */
class MemoryRoutingPort implements TrafficRoutingPort {
	readonly provider = "simple" as const;
	readonly applied: RoutingPlan[] = [];
	private readonly plans = new Map<string, RoutingPlan>();
	activeId: string | undefined;
	degradeAbove = 101;

	/** Acknowledge `full` at or above this candidate weight but leave the old split routing. */
	stuckAbove = 101;

	async apply(plan: RoutingPlan): Promise<ApplyResult> {
		this.applied.push(plan);
		this.plans.set(plan.planId, plan);
		const candidate = plan.backends.find((b) => b.id === "green")?.weight ?? 0;
		const realized = candidate >= this.degradeAbove ? "partial" : "full";
		if (realized === "full" && candidate < this.stuckAbove) this.activeId = plan.planId;
		return { planId: plan.planId, provider: this.provider, realized, notes: [] };
	}

	async status(planId: RoutingPlanId): Promise<RoutingStatus | null> {
		if (!this.plans.has(planId)) return null;
		const active = this.activeId === planId;
		return { planId, active, realized: active ? "full" : "partial", notes: [] };
	}

	weights(): readonly string[] {
		return this.applied.map((plan) => plan.backends.map((b) => `${b.id}:${b.weight ?? "-"}`).join(","));
	}
}

const rollout = (): RolloutId => {
	// SAFETY: literal test id.
	return "rollout-t" as RolloutId;
};

function topology(): RoutingTopology {
	return {
		service: SERVICE,
		tenantId,
		stationId: "station-1",
		backends: [
			{ id: "blue", service: SERVICE, healthy: true },
			{ id: "green", service: SERVICE, healthy: true },
		],
	};
}

function decision() {
	return allowDecision("test", {
		subject: { identity: "station", tenantId, tags: [] },
		action: "routing.plan",
		resource: { kind: "service", id: SERVICE, tenantId },
	});
}

async function setup(overrides: Partial<CampRoutingContext> = {}) {
	const time = clock();
	const port = new MemoryRoutingPort();
	const live = synthesizeRoutingPlan({
		topology: { ...topology(), backends: [{ id: "blue", service: SERVICE, healthy: true, weight: 100 }] },
		policyDecision: decision(),
		now: new Date(T0).toISOString(),
		planId: "live",
		weightStrategy: "static",
	});
	if (live.kind !== "plan") throw new Error("incumbent synthesis failed");
	await port.apply(live.plan);
	port.applied.length = 0;
	const checkpoints: string[] = [];
	const routing: CampRoutingContext = {
		port,
		offerings: ["lb.weighted"],
		topology: topology(),
		policyDecision: decision(),
		stableBackendId: "blue",
		candidateBackendId: "green",
		precondition: { validation: { status: "validated", changeId: "chg-1" } },
		incumbentPlan: live.plan,
		healthGate: () => true,
		restorationHealthGate: () => true,
		beforeApply: async (plan, phase, percent) => {
			checkpoints.push(`${phase}:${percent}:${plan.planId}`);
		},
		...overrides,
	};
	const facts: string[] = [];
	const shifter = createCutoverTrafficShifter({
		routing: async (campId) => (campId === "prod-a" ? routing : undefined),
		now: time.now,
		onFact: (_campId, fact) => facts.push(fact.type),
	});
	return { port, shifter, checkpoints, facts, time, cdctx: context(time.now) };
}

function stage(percent: number): RoutingPlan {
	return stageRoutingPlan({ rolloutId: rollout(), campId: camp("prod-a"), tenant: TENANT, percent, atMs: T0 });
}

const signal = new AbortController().signal;

describe("createCutoverTrafficShifter", () => {
	it("stops a cutover at the stage percent: P is applied, observed and health-gated; nothing beyond P is written", async () => {
		const { port, shifter, checkpoints, facts, cdctx } = await setup();
		const result = await shifter.shift({ campId: camp("prod-a"), plan: stage(25), signal }, cdctx);
		expect(result.realized).toBe("full");
		expect(result.planId).toBe(cutoverPlanId(stage(25).planId));
		expect(port.weights()).toEqual(["blue:75,green:25"]);
		expect(checkpoints).toEqual([`ramp:25:${stage(25).planId}:p25`]);
		expect(facts).toContain("routing.RampAdvanced");
		expect(facts).not.toContain("domain.RoutingChanged");
		const status = await shifter.status(camp("prod-a"), stage(25).planId);
		expect(status).toMatchObject({ active: true, realized: "full" });
	});

	it("walks successive stages from the last realized plan and finishes at 100", async () => {
		const { port, shifter, cdctx } = await setup();
		for (const percent of [5, 50, 100]) {
			const result = await shifter.shift({ campId: camp("prod-a"), plan: stage(percent), signal }, cdctx);
			expect(result.realized).toBe("full");
		}
		expect(port.weights()).toEqual(["blue:95,green:5", "blue:50,green:50", "green:100"]);
		expect(await shifter.status(camp("prod-a"), stage(100).planId)).toMatchObject({ active: true });
	});

	it("zero exposure runs the reverse cutover back to the stable backend (D12)", async () => {
		const { port, shifter, cdctx } = await setup();
		await shifter.shift({ campId: camp("prod-a"), plan: stage(25), signal }, cdctx);
		const result = await shifter.shift({ campId: camp("prod-a"), plan: stage(0), signal }, cdctx);
		expect(result.realized).toBe("full");
		expect(port.weights().at(-1)).toBe("blue:100");
		expect(await shifter.status(camp("prod-a"), stage(0).planId)).toMatchObject({ active: true, realized: "full" });
	});

	it("an unvalidated change is refused before any provider effect", async () => {
		const { port, shifter, cdctx } = await setup({ precondition: { validation: { status: "pending" } } });
		const result = await shifter.shift({ campId: camp("prod-a"), plan: stage(5), signal }, cdctx);
		expect(result.realized).toBe("none");
		expect(result.notes[0]).toBe("traffic-cutover-refused");
		expect(port.applied).toHaveLength(0);
	});

	it("DNS cutover is refused until the old TTL was waited out (domain cutover saga)", async () => {
		const { port, shifter, cdctx } = await setup({
			precondition: {
				validation: { status: "validated" },
				mechanism: "dns",
				ttl: { previousTtlSeconds: 3600, loweredTtlSeconds: 60, waitedSeconds: 600 },
			},
		});
		const result = await shifter.shift({ campId: camp("prod-a"), plan: stage(5), signal }, cdctx);
		expect(result.notes.join(" ")).toContain("ttl-wait-incomplete");
		expect(port.applied).toHaveLength(0);
	});

	it("a failing destination health gate restores the exact last-known-good plan", async () => {
		const { port, shifter, cdctx } = await setup({ healthGate: () => false });
		const result = await shifter.shift({ campId: camp("prod-a"), plan: stage(5), signal }, cdctx);
		expect(result.realized).toBe("none");
		expect(result.notes[0]).toBe("traffic-cutover-rolled-back");
		expect(port.weights()).toEqual(["blue:95,green:5", "blue:100"]);
	});

	it("a degraded provider realization is never reported as converged", async () => {
		const { port, shifter, cdctx } = await setup();
		port.degradeAbove = 50;
		const result = await shifter.shift({ campId: camp("prod-a"), plan: stage(50), signal }, cdctx);
		expect(result.realized).not.toBe("full");
		expect((await shifter.status(camp("prod-a"), stage(50).planId))?.active).not.toBe(true);
	});

	it("an unconfigured Camp has no offerings and refuses to shift", async () => {
		const { shifter, cdctx } = await setup();
		expect(await shifter.offerings(camp("other"))).toEqual([]);
		const result = await shifter.shift({ campId: camp("other"), plan: stage(5), signal }, cdctx);
		expect(result.realized).toBe("none");
		expect(result.notes).toEqual(["traffic-unconfigured"]);
		expect(await shifter.status(camp("other"), stage(5).planId)).toBeNull();
	});

	it("financial checkpoints run before every provider write, including restoration", async () => {
		const { shifter, checkpoints, cdctx } = await setup({ healthGate: () => false });
		await shifter.shift({ campId: camp("prod-a"), plan: stage(5), signal }, cdctx);
		expect(checkpoints.map((c) => c.split(":").slice(0, 2).join(":"))).toEqual(["ramp:5", "restore:0"]);
	});
});

describe("rollout over Station cutover (end to end)", () => {
	async function rollout(configure: (port: MemoryRoutingPort) => void = () => undefined) {
		const station = await setup();
		configure(station.port);
		const store = new MemoryEventStore();
		const desired = new FakeDesired();
		desired.promoted("prod-a", "freight-1");
		const base = { store, tenant: TENANT, now: station.time.now };
		const orchestrator = createRolloutOrchestrator({
			...base,
			engine: createHarnessRolloutEngine(base),
			traffic: station.shifter,
			verification: new FakeVerification(),
			windows: new FakeWindows(),
			desired,
			approvals: new FakeApprovals(),
			telemetry: new RecordingTelemetry(),
		});
		const planned = await orchestrator.plan(
			{
				promotion: promotion({ targets: ["prod-a"], strategy: RolloutStrategy.CANARY }),
				obligations: [],
				verification: spec({ deadlineMs: 10 * MINUTE }),
				stagePercents: [],
				windows: [],
			},
			station.cdctx,
		);
		if (!planned.ok) throw new Error("plan refused");
		return { ...station, orchestrator, plan: planned.value, desired };
	}

	it("canary ramps 5/25/50/100 through Station cutover only and promotes", async () => {
		const r = await rollout();
		const snapshot = await r.orchestrator.run(r.plan, r.cdctx);
		expect(snapshot.status).toBe("promoted");
		expect(r.port.weights()).toEqual(["blue:95,green:5", "blue:75,green:25", "blue:50,green:50", "green:100"]);
	});

	it("§10 provider reports success, traffic still split: non-converged until the deadline, then rolled back", async () => {
		const r = await rollout((port) => {
			port.stuckAbove = 100; // the final flip is acknowledged but never routes
		});
		let snapshot = await r.orchestrator.run(r.plan, r.cdctx);
		expect(snapshot.status).toBe("running");
		expect(snapshot.percent).toBe(100);
		r.time.advance(11 * MINUTE);
		await r.orchestrator.tick(r.cdctx);
		snapshot = (await r.orchestrator.get(snapshot.rolloutId)) ?? snapshot;
		expect(snapshot.status).toBe("rolled-back");
		expect(snapshot.reasons[0]?.code).toBe("rollout-traffic-unconverged");
		expect(r.port.weights().at(-1)).toBe("blue:100");
	});
});
