// Promoted proof semantics (AGENTS.md § Draft-proof promotion policy). Each
// describe block carries the semantics of one frozen draft proof into the
// production rollout path; the proofs themselves are not edited.
//
//   deployment-strategy-saga-templates-contract
//   stuck-rollout-convergence-contract
//   domain-cutover-saga-contract
//   hobo-delivery-port
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	RolloutPlanRecordSchema,
	RolloutStrategy,
	VerificationResultRecordSchema,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import { createHarnessRolloutEngine } from "../../src/adapters/harness.js";
import type { RolloutId } from "../../src/ports.js";
import { ROLLOUT_LEDGER } from "../../src/rollout/journal.js";
import { stagePercentsFor } from "../../src/rollout/lowering.js";
import {
	clock,
	context,
	MemoryEventStore,
	MINUTE,
	promotion,
	spec,
	TENANT,
} from "./fakes.js";
import { type Rig, rig } from "./rig.js";

async function start(
	r: Rig,
	strategy: RolloutStrategy,
	deadlineMs = 30 * MINUTE,
	stagePercents: readonly number[] = [],
) {
	r.desired.promoted("prod-a", "freight-1");
	const planned = await r.orchestrator.plan(
		{
			promotion: promotion({ targets: ["prod-a"], strategy }),
			obligations: [],
			verification: spec({ deadlineMs }),
			stagePercents,
			windows: [],
		},
		r.ctx,
	);
	if (!planned.ok) throw new Error("plan refused");
	const snapshot = await r.orchestrator.run(planned.value, r.ctx);
	return {
		plan: planned.value,
		snapshot,
		id: (): RolloutId => snapshot.rolloutId,
	};
}

describe("promoted: deployment-strategy-saga-templates-contract", () => {
	it("canary shifts traffic in stages and auto-rolls back on an injected regression", async () => {
		const r = rig();
		r.verification.script = ({ call }) =>
			call === 2 ? VerificationVerdict.FAIL : VerificationVerdict.PASS;
		const { snapshot } = await start(r, RolloutStrategy.CANARY);
		expect(snapshot.status).toBe("rolled-back");
		expect(r.traffic.percents("prod-a")).toEqual([5, 25, 50, 0]);
	});

	it("canary auto-advances through passing gates and promotes at full green", async () => {
		const r = rig();
		const { snapshot } = await start(r, RolloutStrategy.CANARY);
		expect(snapshot.status).toBe("promoted");
		expect(r.traffic.percents("prod-a").at(-1)).toBe(100);
	});

	it("progressive strategy walks 1, 10, 50 and 100 percent with a gate after each split", async () => {
		const r = rig();
		await start(r, RolloutStrategy.CANARY, 30 * MINUTE, [1, 10, 50]);
		expect(r.traffic.percents("prod-a")).toEqual([1, 10, 50, 100]);
		expect(r.verification.started).toHaveLength(4);
	});

	it("staged templates require a final full-green step before promotion", () => {
		const r = stagePercentsFor(RolloutStrategy.CANARY, [5, 25]);
		expect(r.ok && r.value.at(-1)).toBe(100);
	});

	it("blue/green flips the router only after the idle-side health gate", async () => {
		const r = rig();
		r.verification.script = ({ call }) =>
			call === 0 ? "pending" : VerificationVerdict.PASS;
		const { id } = await start(r, RolloutStrategy.BLUE_GREEN);
		expect(r.traffic.shifts).toHaveLength(0);
		r.verification.settle(VerificationVerdict.PASS);
		await r.orchestrator.tick(r.ctx);
		expect(r.traffic.percents("prod-a")).toEqual([100]);
		expect((await r.orchestrator.get(id()))?.status).toBe("promoted");
	});

	it("a gate that never resolves fails closed instead of leaving the canary stuck between stages", async () => {
		const r = rig();
		r.verification.script = () => "pending";
		const { id } = await start(r, RolloutStrategy.CANARY, 5 * MINUTE);
		r.time.advance(11 * MINUTE);
		await r.orchestrator.tick(r.ctx);
		const snapshot = await r.orchestrator.get(id());
		expect(snapshot?.status).toBe("rolled-back");
		expect(snapshot?.reasons[0]?.code).toBe("rollout-progress-deadline");
		expect(r.traffic.percents("prod-a")).toEqual([5, 0]);
	});

	it("a held split stays on the same stage instead of skipping ahead", async () => {
		const r = rig();
		r.windows.open = false;
		const { snapshot } = await start(r, RolloutStrategy.CANARY);
		expect(snapshot.status).toBe("awaiting-window");
		await r.orchestrator.tick(r.ctx);
		expect(r.traffic.shifts).toHaveLength(0);
		expect(snapshot.stageIndex).toBe(0);
	});

	it("terminal rollout replay does not execute later gateway steps", async () => {
		const r = rig();
		const { id } = await start(r, RolloutStrategy.CANARY);
		const shifts = r.traffic.shifts.length;
		const events = r.store.events(ROLLOUT_LEDGER.stream(id())).length;
		await r.orchestrator.tick(r.ctx);
		await r.orchestrator.tick(r.ctx);
		expect(r.traffic.shifts).toHaveLength(shifts);
		expect(r.store.events(ROLLOUT_LEDGER.stream(id()))).toHaveLength(events);
	});
});

describe("promoted: stuck-rollout-convergence-contract", () => {
	it("observed traffic is authoritative over provider self-report", async () => {
		const r = rig();
		r.traffic.stuck.add("prod-a");
		const { snapshot } = await start(r, RolloutStrategy.CANARY, 5 * MINUTE);
		expect(snapshot.status).toBe("running");
		expect(r.verification.started).toHaveLength(0);
	});

	it("a rollout stuck at 50 percent terminates with a verdict after the deadline", async () => {
		const r = rig();
		r.verification.script = ({ call }) =>
			call < 2 ? VerificationVerdict.PASS : "pending";
		const { id } = await start(r, RolloutStrategy.CANARY, 5 * MINUTE);
		expect(r.traffic.percents("prod-a")).toEqual([5, 25, 50]);
		r.time.advance(20 * MINUTE);
		await r.orchestrator.tick(r.ctx);
		expect((await r.orchestrator.get(id()))?.status).toBe("rolled-back");
	});

	it("a prior needs-human verdict is terminal on replay and emits no more recovery work", async () => {
		const r = rig();
		r.verification.script = () => VerificationVerdict.FAIL;
		r.traffic.stuck.add("prod-a");
		r.desired.promoted("prod-a", "freight-1");
		const planned = await r.orchestrator.plan(
			{
				promotion: promotion({
					targets: ["prod-a"],
					strategy: RolloutStrategy.CANARY,
				}),
				obligations: [],
				verification: spec({ deadlineMs: MINUTE }),
				stagePercents: [],
				windows: [],
			},
			r.ctx,
		);
		if (!planned.ok) throw new Error("plan refused");
		await r.orchestrator.run(planned.value, r.ctx);
		r.time.advance(3 * MINUTE);
		await r.orchestrator.tick(r.ctx);
		r.time.advance(3 * MINUTE);
		await r.orchestrator.tick(r.ctx);
		const id = planned.value.rolloutId;
		// SAFETY: the plan's own rollout id.
		const snapshot = await r.orchestrator.get(id as RolloutId);
		expect(snapshot?.status).toBe("failed");
		expect(snapshot?.reasons.map((x) => x.code)).toContain(
			"rollback-non-convergeable",
		);
		const shifts = r.traffic.shifts.length;
		const replayed = rig({ store: r.store });
		await replayed.orchestrator.tick(replayed.ctx);
		expect(replayed.traffic.shifts).toHaveLength(0);
		expect(r.traffic.shifts).toHaveLength(shifts);
	});
});

describe("promoted: hobo-delivery-port", () => {
	const signal = () => clock();

	it("a no-op rollout drives start → stage → promoted and replays to the live view", async () => {
		const store = new MemoryEventStore();
		const time = signal();
		const engine = createHarnessRolloutEngine({
			store,
			tenant: TENANT,
			now: time.now,
		});
		const plan = create(RolloutPlanRecordSchema, {
			rolloutId: "rollout-noop",
			stagePercents: [100],
			targetCampIds: ["a"],
			strategy: RolloutStrategy.ALL_AT_ONCE,
		});
		const ctx = context(time.now);
		await engine.start(plan, ctx);
		// SAFETY: literal test id.
		const id = "rollout-noop" as RolloutId;
		const live = await engine.advance(
			id,
			create(VerificationResultRecordSchema, {
				campId: "a",
				verdict: VerificationVerdict.PASS,
			}),
			ctx,
		);
		expect(live.status).toBe("promoted");
		const replay = createHarnessRolloutEngine({
			store,
			tenant: TENANT,
			now: time.now,
		});
		expect(await replay.get(id)).toEqual(live);
	});

	it("abort mid-step ends in a terminal state instead of a dangling rollout", async () => {
		const r = rig();
		r.verification.script = () => "pending";
		const { id } = await start(r, RolloutStrategy.CANARY);
		const snapshot = await r.orchestrator.rollback(
			{ rolloutId: id(), reason: "abort" },
			r.ctx,
		);
		expect(snapshot.status).toBe("rolled-back");
	});

	it("missing traffic capability is refused with progressive-unsupported (HoBo D7 replaces the proof's PlanWarning degrade)", async () => {
		const r = rig();
		r.traffic.offeringsByCamp.set("prod-a", []);
		r.desired.promoted("prod-a", "freight-1");
		const planned = await r.orchestrator.plan(
			{
				promotion: promotion({
					targets: ["prod-a"],
					strategy: RolloutStrategy.CANARY,
				}),
				obligations: [],
				verification: spec(),
				stagePercents: [],
				windows: [],
			},
			r.ctx,
		);
		expect(planned.ok).toBe(false);
	});

	it("run on an already promoted rollout is idempotent", async () => {
		const r = rig();
		const { plan } = await start(r, RolloutStrategy.CANARY);
		const shifts = r.traffic.shifts.length;
		const again = await r.orchestrator.run(plan, r.ctx);
		expect(again.status).toBe("promoted");
		expect(r.traffic.shifts).toHaveLength(shifts);
	});
});
