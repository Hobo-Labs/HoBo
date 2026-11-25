// adapters/harness.ts: RolloutEngine over OpenDeliveryEngine (D8, I8).
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ReasonRecordSchema,
	RolloutPlanRecordSchema,
	RolloutStrategy,
	VerificationResultRecordSchema,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import {
	createHarnessRolloutEngine,
	HARNESS_LEDGER,
	rolloutPolicy,
} from "../../src/adapters/harness.js";
import { WINDOW_CLOSED } from "../../src/events.js";
import type { RolloutId } from "../../src/ports.js";
import { clock, context, MemoryEventStore, TENANT } from "./fakes.js";

const ID = "rollout-h1";
const rolloutId = (): RolloutId => {
	// SAFETY: literal test id.
	return ID as RolloutId;
};

function plan(
	targets: readonly string[] = ["a", "b"],
	stages: readonly number[] = [10, 100],
) {
	return create(RolloutPlanRecordSchema, {
		rolloutId: ID,
		promotionId: "promo-1",
		strategy: RolloutStrategy.CANARY,
		stagePercents: [...stages],
		targetCampIds: [...targets],
	});
}

function result(campId: string, verdict: VerificationVerdict) {
	return create(VerificationResultRecordSchema, {
		campId,
		verdict,
		verificationId: `v-${campId}`,
	});
}

function setup(store = new MemoryEventStore()) {
	const time = clock();
	const engine = createHarnessRolloutEngine({
		store,
		tenant: TENANT,
		now: time.now,
	});
	return { store, time, engine, ctx: context(time.now) };
}

describe("createHarnessRolloutEngine", () => {
	it("lowers a plan to a staged policy with Camps as ordered target groups, no auto-rollback, no gateway weight", () => {
		const policy = rolloutPolicy(plan());
		expect(policy.traffic).toBe("flag-only");
		expect(policy.autoRollback).toBe(false);
		expect(policy.stages.map((s) => s.percent)).toEqual([10, 100]);
		expect(policy.stages[0]?.groups?.map((g) => g.targets)).toEqual([
			["a"],
			["b"],
		]);
		expect(policy.stages[0]?.groups?.every((g) => g.maxFailures === 0)).toBe(
			true,
		);
	});

	it("walks groups and stages from PASS outcomes and promotes", async () => {
		const { engine, ctx } = setup();
		let snap = await engine.start(plan(), ctx);
		expect(snap).toMatchObject({
			rolloutId: ID,
			status: "running",
			stageIndex: 0,
			percent: 10,
		});
		snap = await engine.advance(
			rolloutId(),
			result("a", VerificationVerdict.PASS),
			ctx,
		);
		expect(snap.stageIndex).toBe(0);
		snap = await engine.advance(
			rolloutId(),
			result("b", VerificationVerdict.PASS),
			ctx,
		);
		expect(snap).toMatchObject({ stageIndex: 1, percent: 100 });
		await engine.advance(
			rolloutId(),
			result("a", VerificationVerdict.PASS),
			ctx,
		);
		snap = await engine.advance(
			rolloutId(),
			result("b", VerificationVerdict.PASS),
			ctx,
		);
		expect(snap.status).toBe("promoted");
	});

	it("a FAIL outcome halts the engine (maxFailures 0); rollback records rolled-back", async () => {
		const { engine, ctx } = setup();
		await engine.start(plan(), ctx);
		let snap = await engine.advance(
			rolloutId(),
			result("a", VerificationVerdict.FAIL),
			ctx,
		);
		expect(snap.status).toBe("halted");
		expect(snap.reasons[0]?.code).toBe("rollout-verification-failed");
		snap = await engine.rollback(rolloutId(), "verification failed", ctx);
		expect(snap.status).toBe("rolled-back");
		expect(snap.percent).toBe(0);
	});

	it("an outcome for a Camp outside the current group changes nothing and records nothing", async () => {
		const { engine, ctx, store } = setup();
		await engine.start(plan(), ctx);
		const before = store.events(HARNESS_LEDGER.stream(ID)).length;
		const snap = await engine.advance(
			rolloutId(),
			result("b", VerificationVerdict.PASS),
			ctx,
		);
		expect(snap.stageIndex).toBe(0);
		expect(store.events(HARNESS_LEDGER.stream(ID))).toHaveLength(before);
	});

	it("a window hold reports awaiting-window; the next advance clears it", async () => {
		const { engine, ctx } = setup();
		await engine.start(plan(), ctx);
		const hold = create(ReasonRecordSchema, {
			code: WINDOW_CLOSED,
			message: "freeze",
			remediation: "wait",
		});
		let snap = await engine.hold(rolloutId(), hold, ctx);
		expect(snap.status).toBe("awaiting-window");
		snap = await engine.advance(
			rolloutId(),
			result("a", VerificationVerdict.PASS),
			ctx,
		);
		expect(snap.status).toBe("running");
	});

	it("start is idempotent and the engine rebuilds identically from its command journal (I8)", async () => {
		const live = setup();
		await live.engine.start(plan(), live.ctx);
		await live.engine.start(plan(), live.ctx);
		live.time.advance(1_000);
		await live.engine.advance(
			rolloutId(),
			result("a", VerificationVerdict.PASS),
			live.ctx,
		);
		expect(
			live.store.events(HARNESS_LEDGER.stream(ID)).map((e) => e.type),
		).toEqual([HARNESS_LEDGER.commanded, HARNESS_LEDGER.commanded]);
		const rebuilt = setup(live.store);
		expect(await rebuilt.engine.get(rolloutId())).toEqual(
			await live.engine.get(rolloutId()),
		);
		// The rebuilt engine continues where the live one stopped.
		const snap = await rebuilt.engine.advance(
			rolloutId(),
			result("b", VerificationVerdict.PASS),
			rebuilt.ctx,
		);
		expect(snap.stageIndex).toBe(1);
	});

	it("an unknown rollout is reported, never invented", async () => {
		const { engine, ctx } = setup();
		expect(await engine.get(rolloutId())).toBeUndefined();
		const snap = await engine.advance(
			rolloutId(),
			result("a", VerificationVerdict.PASS),
			ctx,
		);
		expect(snap.status).toBe("failed");
		expect(snap.reasons[0]?.code).toBe("rollout-unknown");
	});

	it("a lost CAS drops the cache and surfaces the conflict", async () => {
		const { engine, ctx, store } = setup();
		await engine.start(plan(), ctx);
		store.failNextAppend = HARNESS_LEDGER.stream("");
		await expect(
			engine.advance(rolloutId(), result("a", VerificationVerdict.PASS), ctx),
		).rejects.toThrow();
		const snap = await engine.advance(
			rolloutId(),
			result("a", VerificationVerdict.PASS),
			ctx,
		);
		expect(snap.status).toBe("running");
	});
});
