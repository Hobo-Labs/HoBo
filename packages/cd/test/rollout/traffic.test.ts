import {
	runTrafficShifterConformance,
	type TrafficShifterLike,
} from "@hobo/conformance";
import {
	type ApplyResult,
	allowDecision,
	parseApplyResult,
	parseTenantId,
	type RoutingPlan,
	type RoutingPlanId,
	type RoutingStatus,
	type TrafficRoutingPort,
} from "@hobo/core";
import type { DispatchFact } from "@hobo/dispatcher";
import { type RoutingTopology, synthesizeRoutingPlan } from "@hobo/stations";
import { describe, expect, it } from "vitest";
import { RolloutStrategy } from "../../src/_generated/cd_pb.js";
import { createHarnessRolloutEngine } from "../../src/adapters/harness.js";
import {
	type CampRoutingContext,
	createCutoverTrafficShifter,
} from "../../src/adapters/traffic.js";
import type { CdContext, RolloutId, TrafficShifter } from "../../src/ports.js";
import { createRolloutOrchestrator } from "../../src/rollout/orchestrator.js";
import { stageRoutingPlan } from "../../src/rollout/routing.js";
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

class MemoryRoutingPort implements TrafficRoutingPort {
	readonly provider = "simple" as const;
	readonly applied: RoutingPlan[] = [];
	private readonly plans = new Map<string, RoutingPlan>();
	activeId: string | undefined;
	degradeAbove = 101;

	stuckAbove = 101;

	async apply(plan: RoutingPlan): Promise<ApplyResult> {
		this.applied.push(plan);
		this.plans.set(plan.planId, plan);
		const candidate = plan.backends.find((b) => b.id === "green")?.weight ?? 0;
		const realized = candidate >= this.degradeAbove ? "partial" : "full";
		if (realized === "full" && candidate < this.stuckAbove)
			this.activeId = plan.planId;
		return parseApplyResult({
			planId: plan.planId,
			provider: this.provider,
			realized,
			notes: [],
			appliedRules: realized === "full" ? 1 : 0,
			unmet: realized === "partial" ? ["fixture requirement"] : [],
			capabilities: ["weighted-backends"],
		});
	}

	async status(planId: RoutingPlanId): Promise<RoutingStatus | null> {
		if (!this.plans.has(planId)) return null;
		const active = this.activeId === planId;
		return { planId, active, realized: active ? "full" : "partial", notes: [] };
	}

	weights(): readonly string[] {
		return this.applied.map((plan) =>
			plan.backends.map((b) => `${b.id}:${b.weight ?? "-"}`).join(","),
		);
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
		topology: {
			...topology(),
			backends: [{ id: "blue", service: SERVICE, healthy: true, weight: 100 }],
		},
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
	const factDetails: DispatchFact[] = [];
	const shifter = createCutoverTrafficShifter({
		routing: async (campId) => (campId === "prod-a" ? routing : undefined),
		now: time.now,
		onFact: (_campId, fact) => {
			facts.push(fact.type);
			factDetails.push(fact);
		},
	});
	return {
		port,
		shifter,
		routing,
		checkpoints,
		facts,
		factDetails,
		time,
		cdctx: context(time.now),
	};
}

function stage(percent: number): RoutingPlan {
	return stageRoutingPlan({
		rolloutId: rollout(),
		campId: camp("prod-a"),
		tenant: TENANT,
		percent,
		atMs: T0,
	});
}

const signal = new AbortController().signal;

describe("createCutoverTrafficShifter", () => {
	it("preserves structured acknowledgement fields for the health gate and caller", async () => {
		const observed: ApplyResult[] = [];
		const { port, shifter, cdctx } = await setup({
			healthGate: ({ applyResult }) => {
				observed.push(applyResult);
				return true;
			},
		});
		const marker = "synthetic-private-provider.invalid";
		const original = port.apply.bind(port);
		port.apply = async (plan) => ({
			...(await original(plan)),
			notes: [marker],
		});
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal },
			cdctx,
		);
		expect(result.realized).toBe("full");
		expect(observed).toHaveLength(1);
		for (const value of [...observed, result]) {
			const parsed = parseApplyResult(JSON.parse(JSON.stringify(value)));
			expect(parsed.appliedRules).toBe(1);
			expect(parsed.capabilities).toEqual(["weighted-backends"]);
		}
		expect(JSON.stringify(observed)).toContain(marker);
		expect(JSON.stringify(result)).not.toContain(marker);
	});

	it("lets health gates inspect provider warnings without exposing them", async () => {
		const marker = "synthetic-private-provider-warning";
		let restorationSawWarning = false;
		const { port, shifter, cdctx, factDetails } = await setup({
			healthGate: ({ applyResult }) => !applyResult.notes.includes(marker),
			restorationHealthGate: ({ applyResult }) => {
				restorationSawWarning = applyResult.notes.includes(marker);
				return true;
			},
		});
		const original = port.apply.bind(port);
		port.apply = async (plan) => ({
			...(await original(plan)),
			notes: [marker],
		});
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal },
			cdctx,
		);
		expect(result.realized).toBe("none");
		expect(result.notes).toContain("traffic-cutover-rolled-back");
		expect(restorationSawWarning).toBe(true);
		expect(JSON.stringify({ result, factDetails })).not.toContain(marker);
	});

	it("treats a malformed acknowledgement as an unknown write outcome", async () => {
		const { port, shifter, cdctx } = await setup();
		const original = port.apply.bind(port);
		port.apply = async (plan) => ({
			...(await original(plan)),
			appliedRules: undefined,
		});
		const plan = stage(5);
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan, signal },
			cdctx,
		);
		expect(result.realized).toBe("partial");
		expect(
			parseApplyResult(JSON.parse(JSON.stringify(result))).unmet?.length,
		).toBeGreaterThan(0);
		expect(await shifter.status(camp("prod-a"), plan.planId)).toMatchObject({
			active: true,
			realized: "full",
		});
	});

	it("satisfies the shared TrafficShifter conformance suite", async () => {
		const wrap = (shifter: TrafficShifter): TrafficShifterLike<CdContext> => ({
			offerings: (campId) => shifter.offerings(camp(campId)),
			shift: ({ campId, ...input }, ctx) =>
				shifter.shift({ ...input, campId: camp(campId) }, ctx),
			status: (campId, planId) => shifter.status(camp(campId), planId),
		});
		const report = await runTrafficShifterConformance({
			subject: "station-cutover",
			campId: "prod-a",
			create: async () => wrap((await setup()).shifter),
			createWithoutTraffic: async () =>
				wrap(
					createCutoverTrafficShifter({
						routing: async () => undefined,
						now: () => T0,
					}),
				),
			plan: stage,
			ctx: () => context(() => T0),
		});
		expect(report.failures).toEqual([]);
	});

	it("does not write traffic when the request is already cancelled", async () => {
		const { port, shifter, cdctx } = await setup();
		const controller = new AbortController();
		controller.abort();
		const plan = stage(5);
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan, signal: controller.signal },
			cdctx,
		);
		expect(result).toMatchObject({ planId: plan.planId, realized: "none" });
		expect(port.applied).toHaveLength(0);
	});

	it("does not write traffic when cancellation occurs during routing preparation", async () => {
		const { port, routing, time, cdctx } = await setup();
		const controller = new AbortController();
		const shifter = createCutoverTrafficShifter({
			routing: async () => {
				controller.abort();
				return routing;
			},
			now: time.now,
		});
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal: controller.signal },
			cdctx,
		);
		expect(result.realized).toBe("none");
		expect(port.applied).toHaveLength(0);
	});

	it("does not dispatch after cancellation at the durable checkpoint", async () => {
		const controller = new AbortController();
		const { port, shifter, cdctx } = await setup({
			beforeApply: async () => {
				controller.abort();
			},
		});
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal: controller.signal },
			cdctx,
		);
		expect(result.realized).toBe("partial");
		expect(port.applied).toHaveLength(0);
	});

	it("keeps a cancelled in-flight write unknown until it can be observed", async () => {
		const { port, shifter, cdctx } = await setup();
		const controller = new AbortController();
		const original = port.apply.bind(port);
		port.apply = async (plan) => {
			await original(plan);
			controller.abort();
			throw new Error("synthetic-private-provider.invalid");
		};
		const plan = stage(5);
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan, signal: controller.signal },
			cdctx,
		);
		expect(result.realized).toBe("partial");
		expect(port.applied).toHaveLength(1);
		expect(await shifter.status(camp("prod-a"), plan.planId)).toMatchObject({
			active: true,
			realized: "full",
		});
	});

	it.each([
		"thrown",
		"notes",
		"realized",
		"plan-id",
		"provider",
		"unmet-not-array",
		"capabilities-not-array",
	] as const)("keeps %s provider acknowledgement details out of results and facts", async (mode) => {
		const { port, shifter, factDetails, cdctx } = await setup();
		const marker = "synthetic-private-provider.invalid";
		const original = port.apply.bind(port);
		port.apply = async (plan) => {
			if (mode === "thrown") throw new Error(marker);
			const result = await original(plan);
			if (mode === "notes")
				return { ...result, notes: [marker], unmet: [marker] };
			if (mode === "realized")
				return { ...result, realized: JSON.parse(JSON.stringify(marker)) };
			if (mode === "plan-id")
				return { ...result, planId: JSON.parse(JSON.stringify(marker)) };
			if (mode === "unmet-not-array")
				return { ...result, unmet: JSON.parse(JSON.stringify(marker)) };
			if (mode === "capabilities-not-array")
				return { ...result, capabilities: JSON.parse(JSON.stringify(marker)) };
			return { ...result, provider: JSON.parse(JSON.stringify(marker)) };
		};
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal },
			cdctx,
		);
		if (mode === "unmet-not-array" || mode === "capabilities-not-array")
			expect(result.realized).toBe("partial");
		expect(JSON.stringify({ result, factDetails })).not.toContain(marker);
		if (mode !== "notes") expect(result.realized).not.toBe("full");
		if (mode === "thrown") expect(port.applied).toHaveLength(0);
	});

	it("strips provider status details and rejects malformed or failing observations", async () => {
		const { port, shifter, cdctx } = await setup();
		const marker = "synthetic-private-provider.invalid";
		await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal },
			cdctx,
		);
		const original = port.status.bind(port);
		port.status = async (planId) => {
			const result = await original(planId);
			return result && { ...result, notes: [marker] };
		};
		const status = await shifter.status(camp("prod-a"), stage(5).planId);
		expect(status).toMatchObject({ active: true, realized: "full", notes: [] });
		expect(JSON.stringify(status)).not.toContain(marker);
		port.status = async () => {
			throw new Error(marker);
		};
		await expect(
			shifter.status(camp("prod-a"), stage(5).planId),
		).rejects.toThrow("Traffic provider status is unavailable.");
		port.status = async (planId) => ({
			planId,
			active: true,
			realized: JSON.parse(JSON.stringify(marker)),
			notes: [],
		});
		await expect(
			shifter.status(camp("prod-a"), stage(5).planId),
		).rejects.toThrow("Traffic provider status is unavailable.");
		port.status = async () => ({
			planId: JSON.parse(JSON.stringify(marker)),
			active: true,
			realized: "full",
			notes: [],
		});
		await expect(
			shifter.status(camp("prod-a"), stage(5).planId),
		).rejects.toThrow("Traffic provider status is unavailable.");
	});

	it("sanitizes a routing context failure at every public entrypoint", async () => {
		const marker = "synthetic-private-provider.invalid";
		const shifter = createCutoverTrafficShifter({
			routing: async () => {
				throw new Error(marker);
			},
			now: () => T0,
		});
		await expect(shifter.offerings(camp("prod-a"))).rejects.toThrow(
			"Traffic offerings are unavailable.",
		);
		await expect(
			shifter.shift(
				{ campId: camp("prod-a"), plan: stage(5), signal },
				context(() => T0),
			),
		).rejects.toThrow("Traffic shift is unavailable.");
		await expect(
			shifter.status(camp("prod-a"), stage(5).planId),
		).rejects.toThrow("Traffic provider status is unavailable.");
	});

	it("keeps provider observation errors out of emitted facts", async () => {
		const { port, shifter, factDetails, cdctx } = await setup();
		const marker = "synthetic-private-provider.invalid";
		const original = port.status.bind(port);
		port.status = async (planId) => {
			if (planId === "live") return original(planId);
			throw new Error(marker);
		};
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal },
			cdctx,
		);
		expect(result.realized).toBe("partial");
		expect(JSON.stringify({ result, factDetails })).not.toContain(marker);
		expect(port.applied).toHaveLength(1);
	});

	it("retains retry classification while redacting transient observation failures", async () => {
		const { port, shifter, factDetails, cdctx } = await setup();
		const marker = "synthetic-private-provider.invalid";
		const original = port.status.bind(port);
		let attempts = 0;
		port.status = async (planId) => {
			if (planId !== "live" && ++attempts < 3)
				throw { failureClass: "transient", message: marker };
			return original(planId);
		};
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal },
			cdctx,
		);
		expect(result.realized).toBe("full");
		expect(attempts).toBe(3);
		expect(JSON.stringify(factDetails)).not.toContain(marker);
	});

	it("keeps policy denial details out of cutover results and facts", async () => {
		const marker = "synthetic-private-policy.invalid";
		const { shifter, factDetails, cdctx } = await setup({
			policyDecision: { ...decision(), effect: "deny", reasons: [marker] },
		});
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal },
			cdctx,
		);
		expect(result.realized).toBe("none");
		expect(JSON.stringify({ result, factDetails })).not.toContain(marker);
	});

	it("stops a cutover at the stage percent: P is applied, observed and health-gated; nothing beyond P is written", async () => {
		const { port, shifter, checkpoints, facts, cdctx } = await setup();
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(25), signal },
			cdctx,
		);
		expect(result.realized).toBe("full");
		expect(result.planId).toBe(stage(25).planId);
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
			const result = await shifter.shift(
				{ campId: camp("prod-a"), plan: stage(percent), signal },
				cdctx,
			);
			expect(result.realized).toBe("full");
		}
		expect(port.weights()).toEqual([
			"blue:95,green:5",
			"blue:50,green:50",
			"green:100",
		]);
		expect(
			await shifter.status(camp("prod-a"), stage(100).planId),
		).toMatchObject({ active: true });
	});

	it("zero exposure runs the reverse cutover back to the stable backend (D12)", async () => {
		const { port, shifter, cdctx } = await setup();
		await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(25), signal },
			cdctx,
		);
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(0), signal },
			cdctx,
		);
		expect(result.realized).toBe("full");
		expect(port.weights().at(-1)).toBe("blue:100");
		expect(await shifter.status(camp("prod-a"), stage(0).planId)).toMatchObject(
			{ active: true, realized: "full" },
		);
	});

	it("an unvalidated change is refused before any provider effect", async () => {
		const { port, shifter, cdctx } = await setup({
			precondition: { validation: { status: "pending" } },
		});
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal },
			cdctx,
		);
		expect(result.realized).toBe("none");
		expect(result.notes[0]).toBe("traffic-cutover-refused");
		expect(port.applied).toHaveLength(0);
	});

	it("DNS cutover is refused until the old TTL was waited out (domain cutover saga)", async () => {
		const { port, shifter, cdctx } = await setup({
			precondition: {
				validation: { status: "validated" },
				mechanism: "dns",
				ttl: {
					previousTtlSeconds: 3600,
					loweredTtlSeconds: 60,
					waitedSeconds: 600,
				},
			},
		});
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal },
			cdctx,
		);
		expect(result.notes.join(" ")).toContain("ttl-wait-incomplete");
		expect(port.applied).toHaveLength(0);
	});

	it("a failing destination health gate restores the exact last-known-good plan", async () => {
		const { port, shifter, cdctx } = await setup({ healthGate: () => false });
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal },
			cdctx,
		);
		expect(result.realized).toBe("none");
		expect(result.notes[0]).toBe("traffic-cutover-rolled-back");
		expect(port.weights()).toEqual(["blue:95,green:5", "blue:100"]);
	});

	it("destination health gate is invoked only for a plan applied and acknowledged in the same shift", async () => {
		const gated: { planId: string; acknowledgedId: string }[] = [];
		const { port, shifter, cdctx } = await setup({
			healthGate: ({ plan, applyResult }) => {
				gated.push({ planId: plan.planId, acknowledgedId: applyResult.planId });
				return true;
			},
		});
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(25), signal },
			cdctx,
		);
		expect(result.realized).toBe("full");
		expect(gated).toHaveLength(1);
		const [gate] = gated;
		expect(gate?.planId).toBe(`${stage(25).planId}:p25`);
		expect(gate?.acknowledgedId).toBe(gate?.planId);
		expect(port.applied.map((plan) => plan.planId)).toContain(gate?.planId);
		expect(gate?.planId).not.toBe("live");
	});

	it("restoration health gate is invoked only for the restoration plan applied in the same shift", async () => {
		const gated: { planId: string; acknowledgedId: string }[] = [];
		const { port, shifter, cdctx } = await setup({
			healthGate: () => false,
			restorationHealthGate: ({ plan, applyResult }) => {
				gated.push({ planId: plan.planId, acknowledgedId: applyResult.planId });
				return true;
			},
		});
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal },
			cdctx,
		);
		expect(result.notes[0]).toBe("traffic-cutover-rolled-back");
		expect(gated).toHaveLength(1);
		const [gate] = gated;
		expect(gate?.planId).toBe(`${stage(5).planId}:p0`);
		expect(gate?.acknowledgedId).toBe(gate?.planId);
		expect(port.applied.map((plan) => plan.planId)).toContain(gate?.planId);
	});

	it("a degraded provider realization is never reported as converged", async () => {
		const { port, shifter, cdctx } = await setup();
		port.degradeAbove = 50;
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(50), signal },
			cdctx,
		);
		expect(result.realized).not.toBe("full");
		expect(
			(await shifter.status(camp("prod-a"), stage(50).planId))?.active,
		).not.toBe(true);
	});

	it("an unconfigured Camp has no offerings and refuses to shift", async () => {
		const { shifter, cdctx } = await setup();
		expect(await shifter.offerings(camp("other"))).toEqual([]);
		const result = await shifter.shift(
			{ campId: camp("other"), plan: stage(5), signal },
			cdctx,
		);
		expect(result.realized).toBe("none");
		expect(result.notes).toEqual(["traffic-unconfigured"]);
		expect(await shifter.status(camp("other"), stage(5).planId)).toBeNull();
	});

	it("financial checkpoints run before every provider write, including restoration", async () => {
		const { shifter, checkpoints, cdctx } = await setup({
			healthGate: () => false,
		});
		await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal },
			cdctx,
		);
		expect(checkpoints.map((c) => c.split(":").slice(0, 2).join(":"))).toEqual([
			"ramp:5",
			"restore:0",
		]);
	});
});

describe("rollout over Station cutover (end to end)", () => {
	async function rollout(
		configure: (port: MemoryRoutingPort) => void = () => undefined,
	) {
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
				promotion: promotion({
					targets: ["prod-a"],
					strategy: RolloutStrategy.CANARY,
				}),
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
		expect(r.port.weights()).toEqual([
			"blue:95,green:5",
			"blue:75,green:25",
			"blue:50,green:50",
			"green:100",
		]);
	});

	it("§10 provider reports success, traffic still split: non-converged until the deadline, then rolled back", async () => {
		const r = await rollout((port) => {
			port.stuckAbove = 100;
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

describe("promoted: domain-cutover-saga-contract", () => {
	it("a clean DNS cutover lowers TTL, waits out the old TTL, shifts the canary, then widens to 100%", async () => {
		const { port, shifter, facts, cdctx } = await setup({
			precondition: {
				validation: { status: "validated", changeId: "dns-1" },
				mechanism: "dns",
				ttl: {
					previousTtlSeconds: 300,
					loweredTtlSeconds: 60,
					waitedSeconds: 300,
				},
			},
		});
		await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(10), signal },
			cdctx,
		);
		await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(100), signal },
			cdctx,
		);
		expect(facts.filter((f) => f === "domain.TtlLowered")).toHaveLength(2);
		expect(port.weights()).toEqual(["blue:90,green:10", "green:100"]);
	});

	it("rollback cannot use a guessed last-known-good record", async () => {
		const guessed = synthesizeRoutingPlan({
			topology: {
				...topology(),
				backends: [
					{ id: "blue", service: SERVICE, healthy: true, weight: 100 },
				],
			},
			policyDecision: decision(),
			now: new Date(T0).toISOString(),
			planId: "guessed",
			weightStrategy: "static",
		});
		if (guessed.kind !== "plan") throw new Error("synthesis failed");
		const { shifter, port, cdctx } = await setup({
			incumbentPlan: guessed.plan,
		});
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(5), signal },
			cdctx,
		);
		expect(result.realized).toBe("none");
		expect(result.notes.join(" ")).toContain("incumbent-not-live");
		expect(port.applied).toHaveLength(0);
	});

	it("flapping health stays in canary watch instead of thrashing rollback", async () => {
		const answers = [false, true];
		const { shifter, port, cdctx } = await setup({
			consecutiveFailuresToRollback: 2,
			healthGate: () => answers.shift() ?? true,
		});
		const result = await shifter.shift(
			{ campId: camp("prod-a"), plan: stage(10), signal },
			cdctx,
		);
		expect(result.realized).toBe("full");
		expect(port.weights()).toEqual(["blue:90,green:10"]);
	});
});
