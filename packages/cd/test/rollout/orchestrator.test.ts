// WP10 Accept bullets and §10 rows for createRolloutOrchestrator, driven over
// the real Harness engine adapter (adapters/harness.ts) and port doubles.
import { describe, expect, it } from "vitest";
import type { RolloutPlanRecord } from "../../src/_generated/cd_pb.js";
import {
	RolloutStrategy,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import {
	CD_RAMP_DEFAULTS,
	PROGRESSIVE_UNSUPPORTED,
	WINDOW_CLOSED,
} from "../../src/events.js";
import type { RolloutId } from "../../src/ports.js";
import { ROLLOUT_LEDGER } from "../../src/rollout/journal.js";
import { ROLLOUT_OBLIGATIONS } from "../../src/rollout/lowering.js";
import {
	camp,
	MemoryEventStore,
	MINUTE,
	obligation,
	promotion,
	spec,
} from "./fakes.js";
import { type Rig, rig } from "./rig.js";

async function planned(
	r: Rig,
	strategy: RolloutStrategy,
	targets: readonly string[] = ["prod-a"],
	extra: Partial<
		Readonly<{
			windows: readonly string[];
			obligations: ReturnType<typeof obligation>[];
			deadlineMs: number;
			stagePercents: readonly number[];
		}>
	> = {},
): Promise<RolloutPlanRecord> {
	for (const target of targets) r.desired.promoted(target, "freight-1");
	const result = await r.orchestrator.plan(
		{
			promotion: promotion({ targets, strategy }),
			obligations: extra.obligations ?? [],
			verification: spec(
				extra.deadlineMs === undefined ? {} : { deadlineMs: extra.deadlineMs },
			),
			stagePercents: extra.stagePercents ?? [],
			windows: extra.windows ?? ["prod-windows"],
		},
		r.ctx,
	);
	if (!result.ok)
		throw new Error(
			`plan refused: ${result.reasons.map((x) => x.code).join(", ")}`,
		);
	return result.value;
}

function rid(plan: RolloutPlanRecord): RolloutId {
	// SAFETY: test reads the plan's own rollout id.
	return plan.rolloutId as RolloutId;
}

describe("createRolloutOrchestrator", () => {
	it("canary walks CD_RAMP_DEFAULTS stage by stage, verifying each split, and promotes", async () => {
		const r = rig();
		const plan = await planned(r, RolloutStrategy.CANARY);
		expect(plan.stagePercents).toEqual([...CD_RAMP_DEFAULTS.canary]);
		expect(plan.lowerings[0]?.offeringId).toBe("lb.weighted");
		expect(plan.lowerings[0]?.fallbackFrom).toEqual(["edge.canary"]);
		const snapshot = await r.orchestrator.run(plan, r.ctx);
		expect(snapshot.status).toBe("promoted");
		expect(snapshot.percent).toBe(100);
		expect(r.traffic.percents("prod-a")).toEqual([5, 25, 50, 100]);
		// Comparisons run while traffic is split; at 100% there is no baseline.
		expect(r.verification.started.map((s) => s.cohortAware)).toEqual([
			true,
			true,
			true,
			false,
		]);
		expect(r.telemetry.named("hobo.cd.rollout.completed")).toHaveLength(1);
		expect(
			r.telemetry.named("hobo.cd.rollout.lowered")[0]?.attributes[
				"hobo.traffic.offering"
			],
		).toBe("lb.weighted");
	});

	it("Accept: FAIL → rollback (zero exposure, then a rollback Delta to the predecessor Set)", async () => {
		const r = rig();
		r.verification.script = ({ call }) =>
			call === 1 ? VerificationVerdict.FAIL : VerificationVerdict.PASS;
		const plan = await planned(r, RolloutStrategy.CANARY);
		const snapshot = await r.orchestrator.run(plan, r.ctx);
		expect(snapshot.status).toBe("rolled-back");
		expect(snapshot.percent).toBe(0);
		expect(r.traffic.percents("prod-a")).toEqual([5, 25, 0]);
		const codes = snapshot.reasons.map((x) => x.code);
		expect(codes).toContain("rollout-verification-failed");
		expect(codes).toContain("rollback-delta-opened");
		const [delta] = [...r.desired.deltas.values()];
		expect(delta?.intent).toBe("rollback");
		expect(delta?.baseSetId).toBe("set-prod-a-freight-1");
		expect(delta?.freightId).toBe("freight-prev");
		expect(delta?.proposal).toBe(false);
		expect((await r.engine.get(rid(plan)))?.status).toBe("rolled-back");
	});

	it("§10 canary error rate significantly worse: INCONCLUSIVE is treated as FAIL", async () => {
		const r = rig();
		r.verification.script = () => VerificationVerdict.INCONCLUSIVE;
		const plan = await planned(r, RolloutStrategy.CANARY);
		const snapshot = await r.orchestrator.run(plan, r.ctx);
		expect(snapshot.status).toBe("rolled-back");
		expect(r.traffic.percents("prod-a")).toEqual([5, 0]);
	});

	it("Accept: provider success with split traffic → non-converged; verdict at the deadline", async () => {
		const r = rig();
		const plan = await planned(r, RolloutStrategy.BLUE_GREEN, ["prod-a"], {
			deadlineMs: 10 * MINUTE,
		});
		r.traffic.stuck.add("prod-a");
		let snapshot = await r.orchestrator.run(plan, r.ctx);
		expect(snapshot.status).toBe("running");
		expect(r.verification.started.map((s) => s.id)).toEqual(["ver-prod-a-0"]); // idle side only
		r.time.advance(9 * MINUTE);
		await r.orchestrator.tick(r.ctx);
		snapshot = (await r.orchestrator.get(rid(plan))) ?? snapshot;
		expect(snapshot.status).toBe("running");
		r.time.advance(2 * MINUTE);
		await r.orchestrator.tick(r.ctx);
		snapshot = (await r.orchestrator.get(rid(plan))) ?? snapshot;
		expect(snapshot.status).not.toBe("promoted");
		expect(snapshot.reasons.map((x) => x.code)).toContain(
			"rollout-traffic-unconverged",
		);
		// The stage was never verified on the strength of a provider self-report.
		expect(r.verification.started).toHaveLength(1);
	});

	it("Accept: required canary with no rung → progressive-unsupported (never a silent downgrade)", async () => {
		const r = rig();
		r.traffic.offeringsByCamp.set("prod-a", ["observe.health", "lb.lifecycle"]);
		r.desired.promoted("prod-a", "freight-1");
		const result = await r.orchestrator.plan(
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
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reasons[0]?.code).toBe(PROGRESSIVE_UNSUPPORTED);
		expect(result.reasons[0]?.remediation).toContain(
			"ROLLOUT_STRATEGY_ALL_AT_ONCE",
		);
		expect(r.traffic.shifts).toHaveLength(0);
		expect(
			r.store.events(
				ROLLOUT_LEDGER.stream(
					r.store.streamIds()[0]?.slice("cd-rollout-".length) ?? "",
				),
			)[0]?.type,
		).toBe("rollout.Lowered");
	});

	it("Accept: a freeze mid-rollout holds at the next boundary and resumes when open", async () => {
		const r = rig();
		r.verification.script = () => "pending";
		const plan = await planned(r, RolloutStrategy.CANARY);
		await r.orchestrator.run(plan, r.ctx);
		expect(r.traffic.percents("prod-a")).toEqual([5]);
		r.windows.open = false; // freeze starts while the 5% stage verifies
		r.verification.settle(VerificationVerdict.PASS);
		await r.orchestrator.tick(r.ctx);
		let snapshot = await r.orchestrator.get(rid(plan));
		expect(snapshot?.status).toBe("awaiting-window");
		expect(snapshot?.reasons[0]?.code).toBe(WINDOW_CLOSED);
		// The in-flight stage was never aborted: 5% stays, nothing advanced.
		expect(r.traffic.percents("prod-a")).toEqual([5]);
		r.time.advance(30 * MINUTE);
		await r.orchestrator.tick(r.ctx);
		expect(r.traffic.percents("prod-a")).toEqual([5]);
		r.windows.open = true;
		r.verification.script = () => VerificationVerdict.PASS;
		await r.orchestrator.tick(r.ctx);
		snapshot = await r.orchestrator.get(rid(plan));
		expect(snapshot?.status).toBe("promoted");
		expect(r.traffic.percents("prod-a")).toEqual([5, 25, 50, 100]);
	});

	it("Accept: replay is identical — a fresh orchestrator and engine over the same journal agree", async () => {
		const store = new MemoryEventStore();
		const live = rig({ store });
		live.verification.script = ({ call }) =>
			call === 2 ? "pending" : VerificationVerdict.PASS;
		const plan = await planned(live, RolloutStrategy.CANARY, [
			"prod-a",
			"prod-b",
		]);
		await live.orchestrator.run(plan, live.ctx);
		const before = await live.orchestrator.get(rid(plan));
		const replayed = rig({ store });
		expect(await replayed.orchestrator.get(rid(plan))).toEqual(before);
		expect(await replayed.engine.get(rid(plan))).toEqual(
			await live.engine.get(rid(plan)),
		);
		// The journal fully determines the next decision too.
		live.verification.settle(VerificationVerdict.PASS);
		await live.orchestrator.tick(live.ctx);
		const finished = await live.orchestrator.get(rid(plan));
		const again = rig({ store });
		expect(await again.orchestrator.get(rid(plan))).toEqual(finished);
	});

	it("exposes one Camp at a time per stage (Camps are ordered target groups)", async () => {
		const r = rig();
		const plan = await planned(
			r,
			RolloutStrategy.CANARY,
			["prod-a", "prod-b"],
			{ stagePercents: [10, 100] },
		);
		const snapshot = await r.orchestrator.run(plan, r.ctx);
		expect(snapshot.status).toBe("promoted");
		expect(r.traffic.shifts.map((s) => `${s.campId}@${s.percent}`)).toEqual([
			"prod-a@10",
			"prod-b@10",
			"prod-a@100",
			"prod-b@100",
		]);
	});

	it("waits for the reconciler to report the promoted Set CONVERGED before any exposure", async () => {
		const r = rig();
		const plan = await planned(r, RolloutStrategy.CANARY);
		r.desired.promoted("prod-a", "freight-1", { converged: false });
		let snapshot = await r.orchestrator.run(plan, r.ctx);
		expect(snapshot.status).toBe("running");
		expect(r.traffic.shifts).toHaveLength(0);
		r.desired.converge("prod-a");
		await r.orchestrator.tick(r.ctx);
		snapshot = (await r.orchestrator.get(rid(plan))) ?? snapshot;
		expect(snapshot.status).toBe("promoted");
	});

	it("an unconverged Camp fails closed at the progress deadline", async () => {
		const r = rig();
		const plan = await planned(r, RolloutStrategy.CANARY, ["prod-a"], {
			deadlineMs: 5 * MINUTE,
		});
		r.desired.promoted("prod-a", "freight-1", { converged: false });
		await r.orchestrator.run(plan, r.ctx);
		r.time.advance(6 * MINUTE);
		await r.orchestrator.tick(r.ctx);
		const snapshot = await r.orchestrator.get(rid(plan));
		expect(snapshot?.status).toBe("rolled-back");
		expect(snapshot?.reasons[0]?.code).toBe("rollout-progress-deadline");
		expect(r.traffic.shifts).toHaveLength(0);
	});

	it("blue/green verifies the idle side, then flips to 100 and verifies again", async () => {
		const r = rig();
		const plan = await planned(r, RolloutStrategy.BLUE_GREEN);
		expect(plan.stagePercents).toEqual([...CD_RAMP_DEFAULTS.blueGreen]);
		const snapshot = await r.orchestrator.run(plan, r.ctx);
		expect(snapshot.status).toBe("promoted");
		expect(r.verification.started.map((s) => s.cohortAware)).toEqual([
			false,
			false,
		]);
		expect(r.traffic.percents("prod-a")).toEqual([100]);
	});

	it("blue/green with a failing idle side never moves traffic", async () => {
		const r = rig();
		r.verification.script = () => VerificationVerdict.FAIL;
		const plan = await planned(r, RolloutStrategy.BLUE_GREEN);
		const snapshot = await r.orchestrator.run(plan, r.ctx);
		expect(snapshot.status).toBe("rolled-back");
		expect(r.traffic.shifts).toHaveLength(0);
	});

	it("experiments hold at their split until experiment.Concluded, then ship", async () => {
		let verdict: "ship" | "do-not-ship" | "inconclusive" | undefined;
		const r = rig({ experiments: { conclusion: async () => verdict } });
		const plan = await planned(r, RolloutStrategy.EXPERIMENT, ["prod-a"], {
			obligations: [
				obligation(ROLLOUT_OBLIGATIONS.experiment, "checkout-copy"),
			],
		});
		expect(plan.stagePercents).toEqual([...CD_RAMP_DEFAULTS.experiment, 100]);
		expect(plan.experimentId).toBe("checkout-copy");
		let snapshot = await r.orchestrator.run(plan, r.ctx);
		expect(snapshot.reasons[0]?.code).toBe("rollout-experiment-running");
		expect(r.traffic.percents("prod-a")).toEqual([50]);
		verdict = "ship";
		await r.orchestrator.tick(r.ctx);
		snapshot = (await r.orchestrator.get(rid(plan))) ?? snapshot;
		expect(snapshot.status).toBe("promoted");
		expect(r.traffic.percents("prod-a")).toEqual([50, 100]);
	});

	it("an experiment concluded do-not-ship rolls back", async () => {
		const r = rig({ experiments: { conclusion: async () => "do-not-ship" } });
		const plan = await planned(r, RolloutStrategy.EXPERIMENT);
		const snapshot = await r.orchestrator.run(plan, r.ctx);
		expect(snapshot.status).toBe("rolled-back");
		expect(snapshot.reasons[0]?.code).toBe("rollout-experiment-rejected");
		expect(r.traffic.percents("prod-a")).toEqual([50, 0]);
	});

	it("reads experiment.Concluded from the journal by default", async () => {
		const r = rig();
		const plan = await planned(r, RolloutStrategy.EXPERIMENT);
		await r.orchestrator.run(plan, r.ctx);
		await r.store.append(
			"experiment-promo-1",
			[
				{
					type: "experiment.Concluded",
					data: { experiment: "promo-1", verdict: "ship" },
				},
			],
			{ expectedSeq: 0, actor: r.ctx.principal, tenant: "acme" },
		);
		await r.orchestrator.tick(r.ctx);
		expect((await r.orchestrator.get(rid(plan)))?.status).toBe("promoted");
	});

	it("stage approvals hold at each boundary after the first exposure and roll back when denied", async () => {
		const r = rig();
		const plan = await planned(r, RolloutStrategy.CANARY, ["prod-a"], {
			obligations: [obligation(ROLLOUT_OBLIGATIONS.stageApproval)],
		});
		let snapshot = await r.orchestrator.run(plan, r.ctx);
		expect(snapshot.status).toBe("awaiting-approval");
		expect(r.traffic.percents("prod-a")).toEqual([5]);
		r.approvals.answer = "approved";
		await r.orchestrator.tick(r.ctx);
		expect(r.traffic.percents("prod-a")).toEqual([5, 25, 50, 100]);
		expect(r.approvals.requests).toHaveLength(3);
		const denied = rig();
		const plan2 = await planned(denied, RolloutStrategy.CANARY, ["prod-a"], {
			obligations: [obligation(ROLLOUT_OBLIGATIONS.stageApproval)],
		});
		await denied.orchestrator.run(plan2, denied.ctx);
		denied.approvals.answer = "denied";
		await denied.orchestrator.tick(denied.ctx);
		snapshot = (await denied.orchestrator.get(rid(plan2))) ?? snapshot;
		expect(snapshot.status).toBe("rolled-back");
		expect(snapshot.reasons[0]?.code).toBe("rollout-approval-denied");
	});

	it("reserves canary capacity through the budget authority before the first exposure", async () => {
		const reserved: string[] = [];
		const r = rig({
			capacity: {
				reserve: async (input) => {
					reserved.push(`${input.campId}@${input.percent}`);
					return { ok: true, value: { reservationId: `res-${input.campId}` } };
				},
			},
		});
		const plan = await planned(r, RolloutStrategy.CANARY, ["prod-a", "prod-b"]);
		expect((await r.orchestrator.run(plan, r.ctx)).status).toBe("promoted");
		expect(reserved).toEqual(["prod-a@5", "prod-b@5"]);
	});

	it("a refused capacity reservation rolls back before traffic moves; an unconfigured one fails closed", async () => {
		const r = rig({
			capacity: {
				reserve: async () => ({
					ok: false,
					reasons: [
						{
							$typeName: "hobo.cd.v1.ReasonRecord",
							code: "canary-capacity-unavailable",
							message: "budget.exhausted",
							remediation: "x",
							subject: "",
						},
					],
				}),
			},
		});
		const plan = await planned(r, RolloutStrategy.CANARY);
		expect((await r.orchestrator.run(plan, r.ctx)).status).toBe("rolled-back");
		expect(r.traffic.shifts).toHaveLength(0);
		const u = rig();
		const plan2 = await planned(u, RolloutStrategy.CANARY, ["prod-a"], {
			obligations: [obligation(ROLLOUT_OBLIGATIONS.hostingBudget)],
		});
		const snapshot = await u.orchestrator.run(plan2, u.ctx);
		expect(snapshot.status).toBe("rolled-back");
		expect(snapshot.reasons[0]?.code).toBe("canary-capacity-unconfigured");
	});

	it("all-at-once never shifts traffic and still verifies before promoting", async () => {
		const r = rig();
		r.traffic.offeringsByCamp.set("prod-a", []);
		const plan = await planned(r, RolloutStrategy.ALL_AT_ONCE);
		expect(plan.stagePercents).toEqual([100]);
		const snapshot = await r.orchestrator.run(plan, r.ctx);
		expect(snapshot.status).toBe("promoted");
		expect(r.traffic.shifts).toHaveLength(0);
		expect(r.verification.started).toHaveLength(1);
	});

	it("rollback in a freeze that forbids rollback holds until the window opens", async () => {
		const r = rig();
		r.verification.script = () => "pending";
		const plan = await planned(r, RolloutStrategy.CANARY);
		await r.orchestrator.run(plan, r.ctx);
		r.windows.open = false;
		r.windows.rollbackAllowed = false;
		let snapshot = await r.orchestrator.rollback(
			{ rolloutId: rid(plan), reason: "operator" },
			r.ctx,
		);
		expect(snapshot.status).toBe("awaiting-window");
		expect(r.traffic.percents("prod-a")).toEqual([5]);
		r.windows.open = true;
		await r.orchestrator.tick(r.ctx);
		snapshot = (await r.orchestrator.get(rid(plan))) ?? snapshot;
		expect(snapshot.status).toBe("rolled-back");
		expect(r.traffic.percents("prod-a")).toEqual([5, 0]);
	});

	it("rollback is allowed in a freeze by default (D10)", async () => {
		const r = rig();
		r.verification.script = () => "pending";
		const plan = await planned(r, RolloutStrategy.CANARY);
		await r.orchestrator.run(plan, r.ctx);
		r.windows.open = false;
		const snapshot = await r.orchestrator.rollback(
			{ rolloutId: rid(plan), reason: "operator" },
			r.ctx,
		);
		expect(snapshot.status).toBe("rolled-back");
	});

	it("a Camp with no predecessor Set rolls back to zero exposure and names teardown", async () => {
		const r = rig();
		r.verification.script = () => VerificationVerdict.FAIL;
		const plan = await planned(r, RolloutStrategy.CANARY);
		r.desired.promoted("prod-a", "freight-1", { predecessor: false });
		const snapshot = await r.orchestrator.run(plan, r.ctx);
		expect(snapshot.status).toBe("rolled-back");
		expect(snapshot.reasons.map((x) => x.code)).toContain(
			"rollback-no-predecessor",
		);
		expect(r.desired.deltas.size).toBe(0);
	});

	it("zero exposure that is never observed escalates to needs-human at the deadline", async () => {
		const r = rig();
		r.verification.script = () => VerificationVerdict.FAIL;
		const plan = await planned(r, RolloutStrategy.CANARY, ["prod-a"], {
			deadlineMs: 5 * MINUTE,
		});
		r.traffic.stuck.add("prod-a");
		r.traffic.active.set(camp("prod-a"), "manual"); // first shift is not observed either
		await r.orchestrator.run(plan, r.ctx);
		await r.orchestrator.rollback(
			{ rolloutId: rid(plan), reason: "operator" },
			r.ctx,
		);
		r.time.advance(6 * MINUTE);
		await r.orchestrator.tick(r.ctx);
		const snapshot = await r.orchestrator.get(rid(plan));
		expect(snapshot?.status).toBe("failed");
		expect(snapshot?.reasons.map((x) => x.code)).toContain(
			"rollback-non-convergeable",
		);
	});

	it("a crash between the shift intent and its acknowledgement resumes by observation, never a second shift", async () => {
		const store = new MemoryEventStore();
		const r = rig({ store });
		r.verification.script = () => VerificationVerdict.PASS;
		const plan = await planned(r, RolloutStrategy.CANARY, ["prod-a"], {
			stagePercents: [5, 100],
		});
		r.traffic.throwOn.add("prod-a"); // the provider call dies mid-flight
		await r.orchestrator.run(plan, r.ctx);
		expect(r.traffic.percents("prod-a")).toEqual([5]);
		// The 5% plan did reach the provider: observation settles the outcome.
		r.traffic.throwOn.delete("prod-a");
		r.traffic.active.set(camp("prod-a"), `${plan.rolloutId}:prod-a:p5`);
		const resumed = rig({ store });
		Object.assign(resumed.traffic, { active: r.traffic.active });
		resumed.desired.promoted("prod-a", "freight-1");
		await resumed.orchestrator.tick(resumed.ctx);
		expect(resumed.traffic.percents("prod-a")).toEqual([100]);
		expect((await resumed.orchestrator.get(rid(plan)))?.status).toBe(
			"promoted",
		);
	});

	it("two drivers on one rollout never both shift (CAS on the ledger)", async () => {
		const store = new MemoryEventStore();
		const a = rig({ store });
		a.verification.script = () => "pending";
		const plan = await planned(a, RolloutStrategy.CANARY);
		await a.orchestrator.run(plan, a.ctx);
		const b = rig({ store });
		b.desired.promoted("prod-a", "freight-1");
		b.verification.script = () => "pending";
		await Promise.all([a.orchestrator.tick(a.ctx), b.orchestrator.tick(b.ctx)]);
		expect([
			...a.traffic.percents("prod-a"),
			...b.traffic.percents("prod-a"),
		]).toEqual([5]);
	});

	it("plan is idempotent; run refuses an unplanned or edited plan", async () => {
		const r = rig();
		const plan = await planned(r, RolloutStrategy.CANARY);
		const again = await r.orchestrator.plan(
			{
				promotion: promotion({
					targets: ["prod-a"],
					strategy: RolloutStrategy.CANARY,
				}),
				obligations: [],
				verification: spec(),
				stagePercents: [],
				windows: ["prod-windows"],
			},
			r.ctx,
		);
		expect(again.ok && again.value.rolloutId).toBe(plan.rolloutId);
		const edited = { ...plan, stagePercents: [100] };
		expect((await r.orchestrator.run(edited, r.ctx)).reasons[0]?.code).toBe(
			"rollout-plan-mismatch",
		);
		const unplanned = { ...plan, rolloutId: "rollout-nope" };
		expect((await r.orchestrator.run(unplanned, r.ctx)).reasons[0]?.code).toBe(
			"rollout-unplanned",
		);
	});

	it("refuses invalid stage percents and incomplete promotions with typed reasons", async () => {
		const r = rig();
		const bad = await r.orchestrator.plan(
			{
				promotion: promotion({
					targets: ["prod-a"],
					strategy: RolloutStrategy.CANARY,
				}),
				obligations: [],
				verification: spec(),
				stagePercents: [50, 25],
				windows: [],
			},
			r.ctx,
		);
		expect(!bad.ok && bad.reasons[0]?.code).toBe("rollout-stages-invalid");
		const empty = await r.orchestrator.plan(
			{
				promotion: promotion({ targets: [], strategy: RolloutStrategy.CANARY }),
				obligations: [],
				verification: spec(),
				stagePercents: [],
				windows: [],
			},
			r.ctx,
		);
		expect(!empty.ok && empty.reasons[0]?.code).toBe("rollout-targets-missing");
	});

	it("an unspecified strategy lowers to canary, never to all-at-once", async () => {
		const r = rig();
		const plan = await planned(r, RolloutStrategy.UNSPECIFIED);
		expect(plan.strategy).toBe(RolloutStrategy.CANARY);
	});

	it("a shift the cutover refuses rolls back at once", async () => {
		const r = rig();
		r.traffic.refuse.add("prod-a");
		const plan = await planned(r, RolloutStrategy.CANARY);
		const snapshot = await r.orchestrator.run(plan, r.ctx);
		expect(snapshot.status).toBe("rolled-back");
		expect(snapshot.reasons[0]?.code).toBe("rollout-shift-failed");
	});
});
