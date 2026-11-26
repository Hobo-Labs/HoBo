import { describe, expect, it } from "vitest";

import {
	FeatureFlagStore,
	OpenDeliveryEngine,
	ROLLOUT_EVENTS,
	type RolloutPolicy,
	replayRolloutJournal,
} from "../src/index.js";

function fixedClock(startMs = 1_750_000_000_000): () => string {
	let tick = 0;
	return () => {
		tick += 1;
		return new Date(startMs + tick * 1000).toISOString();
	};
}

function makeEngine(): OpenDeliveryEngine {
	return new OpenDeliveryEngine({
		store: new FeatureFlagStore(),
		now: fixedClock(),
	});
}

const stagedPolicy: RolloutPolicy = {
	name: "staged-canary",
	flag: "staged-flag",
	traffic: "flag-only",
	autoRollback: false,
	stages: [
		{
			percent: 10,
			groups: [
				{ name: "canary", targets: ["a", "b"], maxFailures: 1 },
				{ name: "rest", targets: ["c", "d", "e"], concurrency: 2 },
			],
		},
		{ percent: 100, approval: true },
	],
};

describe("Staged rollout strategies · groups / concurrency / maxFailures / approval / resume", () => {
	it("walks groups in order, tolerates failure below threshold, halts at approval barrier, and journal replay reconstructs identical state", () => {
		const engine = makeEngine();
		const started = engine.start(stagedPolicy);
		const id = started.id;
		expect(started.status).toBe("running");
		expect(started.staged).toEqual({
			groupIndex: 0,
			completedTargets: [],
			failedTargets: [],
		});

		// Group 1 (canary): both targets dispatched (no concurrency cap).
		expect(engine.nextBatch(id)).toEqual(["a", "b"]);
		const afterCanary = engine.reportOutcomes(id, [
			{ target: "a", ok: true },
			{ target: "b", ok: false },
		]);
		// One failure ≤ maxFailures(1): group completes, no halt.
		expect(afterCanary.status).toBe("running");
		expect(afterCanary.staged?.groupIndex).toBe(1);

		// Group 2 (rest): concurrency caps the batch at 2.
		expect(engine.nextBatch(id)).toEqual(["c", "d"]);
		engine.reportOutcomes(id, [
			{ target: "c", ok: true },
			{ target: "d", ok: true },
		]);
		expect(engine.nextBatch(id)).toEqual(["e"]);
		const awaiting = engine.reportOutcomes(id, [{ target: "e", ok: true }]);

		// Stage 2 is approval-gated: rollout pauses at the barrier.
		expect(awaiting.status).toBe("awaiting_approval");
		expect(awaiting.pendingApproval).toEqual({
			stageIndex: 1,
			groupIndex: 0,
			scope: "stage",
		});
		expect(engine.nextBatch(id)).toEqual([]);
		expect(engine.step(id).status).toBe("awaiting_approval");

		const granted = engine.grantApproval(id, "release-captain");
		expect(granted.status).toBe("running");
		expect(granted.percent).toBe(100);
		const done = engine.step(id);
		expect(done.status).toBe("promoted");

		const types = engine.events.map((e) => e.type);
		expect(types).toEqual([
			ROLLOUT_EVENTS.Started,
			ROLLOUT_EVENTS.StageStarted,
			ROLLOUT_EVENTS.GroupProgressed,
			ROLLOUT_EVENTS.GroupCompleted,
			ROLLOUT_EVENTS.GroupProgressed,
			ROLLOUT_EVENTS.GroupProgressed,
			ROLLOUT_EVENTS.GroupCompleted,
			ROLLOUT_EVENTS.StageCompleted,
			ROLLOUT_EVENTS.ApprovalRequested,
			ROLLOUT_EVENTS.ApprovalGranted,
			ROLLOUT_EVENTS.Stepped,
			ROLLOUT_EVENTS.Promoted,
		]);

		// Determinism: replaying the journal reconstructs identical state.
		const replayed = replayRolloutJournal(engine.events);
		expect([...replayed.values()]).toStrictEqual([...engine.list()]);
	});

	it("maxFailures aborts the group: rollout halts with the resume position recorded", () => {
		const engine = makeEngine();
		const started = engine.start({
			name: "halt-me",
			flag: "halt-flag",
			traffic: "flag-only",
			autoRollback: false,
			stages: [
				{
					percent: 20,
					// Default maxFailures = 0: fail-fast on the first failure.
					groups: [{ name: "wave", targets: ["a", "b", "c"] }],
				},
			],
		});
		const id = started.id;
		const halted = engine.reportOutcomes(id, [
			{ target: "a", ok: true },
			{ target: "b", ok: false },
		]);
		expect(halted.status).toBe("halted");
		expect(halted.resumeFrom).toEqual({ stageIndex: 0, groupIndex: 0 });
		expect(halted.reason).toBe("max-failures-exceeded");
		expect(halted.staged?.completedTargets).toEqual(["a"]);
		expect(halted.staged?.failedTargets).toEqual(["b"]);
		expect(engine.nextBatch(id)).toEqual([]);
		expect(() =>
			engine.reportOutcomes(id, [{ target: "c", ok: true }]),
		).toThrow(/no staged group in progress/);
		expect(engine.events.some((e) => e.type === ROLLOUT_EVENTS.Halted)).toBe(
			true,
		);
	});

	it("resume continues a halted rollout from its recorded position (failed targets retry) and replays deterministically", () => {
		const engine = makeEngine();
		const started = engine.start({
			name: "resume-me",
			flag: "resume-flag",
			traffic: "flag-only",
			autoRollback: false,
			stages: [
				{
					percent: 50,
					groups: [{ name: "wave", targets: ["a", "b"] }],
				},
			],
		});
		const id = started.id;
		engine.reportOutcomes(id, [
			{ target: "a", ok: true },
			{ target: "b", ok: false },
		]);
		expect(engine.get(id)?.status).toBe("halted");

		const resumed = engine.resume(id);
		expect(resumed.status).toBe("running");
		expect(resumed.staged).toEqual({
			groupIndex: 0,
			completedTargets: ["a"],
			failedTargets: [],
		});
		// Completed target is not redone; the failed one retries.
		expect(engine.nextBatch(id)).toEqual(["b"]);
		const done = engine.reportOutcomes(id, [{ target: "b", ok: true }]);
		expect(done.status).toBe("promoted");
		expect(engine.events.some((e) => e.type === ROLLOUT_EVENTS.Resumed)).toBe(
			true,
		);

		const replayed = replayRolloutJournal(engine.events);
		expect([...replayed.values()]).toStrictEqual([...engine.list()]);
	});

	it("resume rejects rollouts that are not halted", () => {
		const engine = makeEngine();
		const started = engine.start(stagedPolicy);
		expect(() => engine.resume(started.id)).toThrow(/not halted/);
	});

	it("approval-gated first stage starts dark until granted", () => {
		const engine = makeEngine();
		const started = engine.start({
			name: "gated-start",
			flag: "gated-flag",
			traffic: "flag-only",
			autoRollback: false,
			stages: [
				{
					percent: 25,
					approval: true,
					groups: [{ name: "wave", targets: ["a"] }],
				},
			],
		});
		const id = started.id;
		expect(started.status).toBe("awaiting_approval");
		expect(started.percent).toBe(0);
		expect(engine.nextBatch(id)).toEqual([]);

		const granted = engine.grantApproval(id, "gatekeeper-decision");
		expect(granted.status).toBe("running");
		expect(granted.percent).toBe(25);
		expect(engine.nextBatch(id)).toEqual(["a"]);
		expect(() => engine.grantApproval(id, "again")).toThrow(
			/no pending approval/,
		);
	});

	it("group-scoped approval barrier pauses between groups", () => {
		const engine = makeEngine();
		const started = engine.start({
			name: "group-gate",
			flag: "group-gate-flag",
			traffic: "flag-only",
			autoRollback: false,
			stages: [
				{
					percent: 30,
					groups: [
						{ name: "canary", targets: ["a"] },
						{ name: "fleet", targets: ["b"], approval: true },
					],
				},
			],
		});
		const id = started.id;
		const awaiting = engine.reportOutcomes(id, [{ target: "a", ok: true }]);
		expect(awaiting.status).toBe("awaiting_approval");
		expect(awaiting.pendingApproval).toEqual({
			stageIndex: 0,
			groupIndex: 1,
			scope: "group",
		});
		const granted = engine.grantApproval(id, "release-captain");
		expect(granted.status).toBe("running");
		expect(engine.nextBatch(id)).toEqual(["b"]);
		const done = engine.reportOutcomes(id, [{ target: "b", ok: true }]);
		expect(done.status).toBe("promoted");
	});

	it("percent-only ramps remain the degenerate case: no staged fields, no staged events, replayable", () => {
		const engine = makeEngine();
		const started = engine.start({
			name: "legacy-ramp",
			flag: "legacy-flag",
			traffic: "gateway-weighted",
			autoRollback: true,
			stages: [{ percent: 10 }, { percent: 50 }],
		});
		const id = started.id;
		expect(started.percent).toBe(10);
		expect(started.staged).toBeUndefined();
		expect(engine.nextBatch(id)).toEqual([]);
		expect(engine.step(id).percent).toBe(50);
		expect(engine.step(id).status).toBe("promoted");
		const stagedEventTypes = new Set<string>([
			ROLLOUT_EVENTS.StageStarted,
			ROLLOUT_EVENTS.GroupProgressed,
			ROLLOUT_EVENTS.GroupCompleted,
			ROLLOUT_EVENTS.StageCompleted,
			ROLLOUT_EVENTS.ApprovalRequested,
			ROLLOUT_EVENTS.ApprovalGranted,
			ROLLOUT_EVENTS.Halted,
			ROLLOUT_EVENTS.Resumed,
		]);
		expect(engine.events.some((e) => stagedEventTypes.has(e.type))).toBe(false);
		const replayed = replayRolloutJournal(engine.events);
		expect([...replayed.values()]).toStrictEqual([...engine.list()]);
	});

	it("step refuses to skip an in-progress staged stage", () => {
		const engine = makeEngine();
		const started = engine.start(stagedPolicy);
		expect(() => engine.step(started.id)).toThrow(/staged stage in progress/);
	});
});
