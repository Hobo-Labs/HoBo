/**
 * The assignment register kept on ephemeral-state stores: the replica's local
 * rules, atomicity per backend, TTL, and what a lost or expired log does to
 * the register's safety.
 */
import {
	EPHEMERAL_STATE_MAX_TTL_MS,
	parseEphemeralKey,
	parseEphemeralTtlMs,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	type AssignmentResolution,
	assignmentKey,
	bootstrapAssignment,
	completeAssignment,
	decodeAssignmentLog,
	encodeAssignmentLog,
	ephemeralAssignmentReplica,
	type FleetAssignment,
	proposeAssignment,
	readAssignmentReplies,
	readCurrentAssignment,
	rejoinAssignmentReplicas,
	resolveAssignment,
} from "../src/index.js";
import {
	cacheFleet,
	entry,
	LOG_KEY,
	seeded,
	testBackend,
	writer,
} from "./fixtures.js";

const key = parseEphemeralKey(LOG_KEY);

describe("one replica's rules", () => {
	it("takes epoch 1 on an empty log, then only the next epoch", async () => {
		const backend = testBackend("c0");
		const replica = ephemeralAssignmentReplica(backend.state, "c0", {
			key: LOG_KEY,
		});
		expect(await replica.read()).toEqual([]);
		expect(await replica.accept(entry(2, "c0"))).toBe("gap");
		expect(await replica.accept(entry(1, "c0"))).toBe("accepted");
		expect(await replica.accept(entry(1, "c0"))).toBe("duplicate");
		expect(await replica.accept(entry(1, "c1"))).toBe("conflict");
		expect(await replica.accept(entry(3, "c0"))).toBe("gap");
		expect(await replica.accept(entry(2, "c1"))).toBe("accepted");
		expect((await replica.read()).map((row) => row.epoch)).toEqual([1, 2]);
		expect((await replica.read(1)).map((row) => row.epoch)).toEqual([2]);
	});

	it("keeps the newest entries only, and cannot vouch for a dropped epoch", async () => {
		const backend = testBackend("c0");
		const replica = ephemeralAssignmentReplica(backend.state, "c0", {
			key: LOG_KEY,
			maxEntries: 3,
		});
		for (let epoch = 1; epoch <= 5; epoch += 1)
			expect(await replica.accept(entry(epoch, "c0"))).toBe("accepted");
		expect((await replica.read()).map((row) => row.epoch)).toEqual([3, 4, 5]);
		// Epoch 1 was held and dropped: which entry it was is no longer known.
		expect(await replica.accept(entry(1, "c0"))).toBe("conflict");
		expect(await replica.accept(entry(6, "c0"))).toBe("accepted");
	});

	it("is atomic per backend: two writers racing for one epoch, one wins", async () => {
		const backend = testBackend("c0");
		const left = ephemeralAssignmentReplica(backend.state, "c0", {
			key: LOG_KEY,
		});
		const right = ephemeralAssignmentReplica(backend.state, "c0", {
			key: LOG_KEY,
		});
		for (let round = 1; round <= 20; round += 1) {
			const outcomes = await Promise.all([
				left.accept(entry(round, "c0", { decidedBy: "left" })),
				right.accept(entry(round, "c0", { decidedBy: "right" })),
			]);
			expect(outcomes.filter((outcome) => outcome === "accepted")).toHaveLength(
				1,
			);
			expect(outcomes.filter((outcome) => outcome === "conflict")).toHaveLength(
				1,
			);
		}
		expect((await left.read()).map((row) => row.epoch)).toHaveLength(20);
	});

	it("sets a 30-day TTL on every write; refresh resets it; a lapsed log reads empty", async () => {
		const backend = testBackend("c0");
		const replica = ephemeralAssignmentReplica(backend.state, "c0", {
			key: LOG_KEY,
		});
		expect(await replica.refresh()).toBe(false);
		await replica.accept(entry(1, "c0"));
		backend.nowMs += EPHEMERAL_STATE_MAX_TTL_MS - 1000;
		expect(await replica.refresh()).toBe(true);
		backend.nowMs += EPHEMERAL_STATE_MAX_TTL_MS - 1000;
		expect(await replica.read()).toHaveLength(1);
		backend.nowMs += 2000;
		expect(await replica.read()).toEqual([]);
		expect(() =>
			ephemeralAssignmentReplica(backend.state, "c0", {
				ttlMs: EPHEMERAL_STATE_MAX_TTL_MS + 1,
			}),
		).toThrow(/ttlMs/u);
	});

	it("reads a corrupt log as a failure, never as empty", async () => {
		const backend = testBackend("c0");
		await backend.state.putIfAbsent(
			key,
			'{"format":1,"entries":[{"epoch":"2"}]}',
			parseEphemeralTtlMs(60_000),
		);
		const replica = ephemeralAssignmentReplica(backend.state, "c0", {
			key: LOG_KEY,
		});
		await expect(replica.read()).rejects.toThrow(/assignment/u);
		await expect(replica.accept(entry(1, "c0"))).rejects.toThrow();
		expect(() => decodeAssignmentLog("not json")).toThrow(/does not parse/u);
		expect(() =>
			decodeAssignmentLog(
				encodeAssignmentLog([entry(1, "c0"), entry(3, "c0")]),
			),
		).toThrow(/contiguous/u);
	});

	it("round-trips every field through the stored log", () => {
		const sealed = entry(7, "c0", {
			sealed: true,
			target: "c1",
			lossWindowMs: 1234,
			decidedAtMs: 1_800_000_000_000,
			reason: "switch:commands-projected",
		});
		const [back] = decodeAssignmentLog(encodeAssignmentLog([sealed]));
		expect(back && assignmentKey(back)).toBe(assignmentKey(sealed));
	});
});

describe("the register on cache replicas", () => {
	it("bootstraps, proposes and reads by majority", async () => {
		const { register } = cacheFleet(3);
		expect((await readCurrentAssignment(register)).status).toBe("empty");
		expect((await bootstrapAssignment(register, "c0")).status).toBe("decided");
		const second = await proposeAssignment(register, {
			expectedEpoch: 1,
			value: writer("c1"),
			decidedBy: "test",
			nowMs: 5,
		});
		expect(second).toMatchObject({
			status: "decided",
			holders: ["c1", "c0", "c2"],
		});
		const current = await readCurrentAssignment(register);
		expect(current).toMatchObject({ status: "current" });
		expect(
			current.status === "current" ? current.assignment.active : undefined,
		).toBe("c1");
	});

	it("fails closed with no majority, and a stale proposer writes nothing", async () => {
		const fleet = cacheFleet(3);
		await bootstrapAssignment(fleet.register, "c0");
		fleet.backend("c1").down = true;
		fleet.backend("c2").down = true;
		expect((await readCurrentAssignment(fleet.register)).status).toBe(
			"no-majority",
		);
		expect(
			(
				await proposeAssignment(fleet.register, {
					expectedEpoch: 1,
					value: writer("c0"),
					decidedBy: "test",
					nowMs: 5,
				})
			).status,
		).toBe("unavailable");
		fleet.backend("c1").down = false;
		fleet.backend("c2").down = false;
		const stale = await proposeAssignment(fleet.register, {
			expectedEpoch: 0,
			value: writer("c2"),
			decidedBy: "test",
			nowMs: 6,
		});
		expect(stale.status).toBe("stale");
	});
});

/** Read and insist on `current`; return its entry. */
async function current(
	register: Parameters<typeof readCurrentAssignment>[0],
): Promise<FleetAssignment> {
	const resolution: AssignmentResolution =
		await readCurrentAssignment(register);
	if (resolution.status !== "current")
		throw new Error(`expected current, got ${resolution.status}`);
	return resolution.assignment;
}

describe("a lost or expired log on a minority", () => {
	it("leaves the current entry current, and repair copies the log back", async () => {
		const fleet = cacheFleet(3);
		await bootstrapAssignment(fleet.register, "c0");
		await proposeAssignment(fleet.register, {
			expectedEpoch: 1,
			value: writer("c1"),
			decidedBy: "test",
			nowMs: 1,
		});
		const before = await current(fleet.register);
		fleet.backend("c2").wipe();
		expect(assignmentKey(await current(fleet.register))).toBe(
			assignmentKey(before),
		);
		// The proposer first brings c2 up from the entries c0 and c1 still hold.
		const next = await proposeAssignment(fleet.register, {
			expectedEpoch: 2,
			value: writer("c2"),
			decidedBy: "test",
			nowMs: 2,
		});
		expect(next).toMatchObject({
			status: "decided",
			holders: ["c2", "c0", "c1"],
		});
	});

	it("rejoins a member whose log was lost once the old epochs are trimmed everywhere", async () => {
		const fleet = cacheFleet(3, 2);
		await bootstrapAssignment(fleet.register, "c0");
		for (let epoch = 1; epoch <= 3; epoch += 1)
			await proposeAssignment(fleet.register, {
				expectedEpoch: epoch,
				value: writer(`c${epoch % 3}`),
				decidedBy: "test",
				nowMs: epoch,
			});
		const before = await current(fleet.register);
		fleet.backend("c1").wipe();
		expect(assignmentKey(await current(fleet.register))).toBe(
			assignmentKey(before),
		);
		// The next decision needs the two members that still hold the log.
		const next = await proposeAssignment(fleet.register, {
			expectedEpoch: before.epoch,
			value: writer("c2"),
			decidedBy: "test",
			nowMs: 10,
		});
		expect(next).toMatchObject({ status: "decided", holders: ["c2", "c0"] });
		// Rejoin: proven current by c0 and c2, so c1 is seeded with it.
		expect(await rejoinAssignmentReplicas(fleet.register)).toEqual([
			{ replica: "c1", outcome: "seeded" },
		]);
		const [seededEntry] = (await fleet.replicas[1]?.read()) ?? [];
		expect(seededEntry && assignmentKey(seededEntry)).toBe(
			next.status === "decided" ? assignmentKey(next.assignment) : "",
		);
		// From there it takes the next epoch like any member.
		const after = await proposeAssignment(fleet.register, {
			expectedEpoch: before.epoch + 1,
			value: writer("c1"),
			decidedBy: "test",
			nowMs: 11,
		});
		expect(after).toMatchObject({
			status: "decided",
			holders: ["c1", "c0", "c2"],
		});
	});

	it("treats an expired log like a lost one", async () => {
		const fleet = cacheFleet(3);
		await bootstrapAssignment(fleet.register, "c0");
		const before = await current(fleet.register);
		fleet.backend("c2").nowMs += EPHEMERAL_STATE_MAX_TTL_MS + 1;
		expect(await fleet.replicas[2]?.read()).toEqual([]);
		expect(assignmentKey(await current(fleet.register))).toBe(
			assignmentKey(before),
		);
		// The refresh tick keeps the others alive; c2 is rejoined.
		for (const replica of fleet.replicas) await replica.refresh();
		expect(await rejoinAssignmentReplicas(fleet.register)).toEqual([
			{ replica: "c2", outcome: "seeded" },
		]);
	});

	it("does not rejoin a member when the others cannot prove the current entry", async () => {
		const fleet = cacheFleet(3);
		await bootstrapAssignment(fleet.register, "c0");
		fleet.backend("c1").wipe();
		fleet.backend("c2").down = true;
		expect(await rejoinAssignmentReplicas(fleet.register)).toEqual([
			{ replica: "c1", outcome: "unproven" },
		]);
		expect(await fleet.replicas[1]?.read()).toEqual([]);
	});

	it("fails closed when a bare majority's member loses the entry before repair", async () => {
		const fleet = cacheFleet(3);
		await bootstrapAssignment(fleet.register, "c0");
		// Epoch 2 reaches c0 and c1 only.
		fleet.backend("c2").down = true;
		await proposeAssignment(fleet.register, {
			expectedEpoch: 1,
			value: writer("c1"),
			decidedBy: "test",
			nowMs: 2,
		});
		fleet.backend("c2").down = false;
		fleet.backend("c1").wipe();
		// One holder of epoch 2 is visible: not proven, so no answer.
		expect((await readCurrentAssignment(fleet.register)).status).toBe(
			"undecided",
		);
		// Completion re-decides the same entry rather than inventing another.
		const completed = await completeAssignment(fleet.register);
		expect(completed).toMatchObject({ status: "current" });
		if (completed.status === "current")
			expect(completed.assignment).toMatchObject({ epoch: 2, active: "c1" });
	});

	/**
	 * Random runs: stale proposers, completions, members going silent, and
	 * logs lost on a minority, but only after repair has copied the current
	 * entry everywhere (the precondition the replica documents). Every entry
	 * ever read as current is recorded per epoch: no epoch may ever resolve to
	 * two entries, and the current epoch never goes back.
	 */
	it("never resolves two entries for one epoch", async () => {
		let wipes = 0;
		for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
			const random = seeded(seed);
			const size = random.pick([3, 5]);
			const fleet = cacheFleet(size);
			const ids = fleet.backends.map((backend) => backend.id);
			const decided = new Map<number, string>();
			let highest = 0;
			const observe = (resolution: AssignmentResolution) => {
				if (resolution.status !== "current") return;
				const { assignment } = resolution;
				const seen = decided.get(assignment.epoch);
				const keyOf = assignmentKey(assignment);
				if (seen !== undefined) expect(keyOf).toBe(seen);
				decided.set(assignment.epoch, keyOf);
				expect(assignment.epoch).toBeGreaterThanOrEqual(highest);
				highest = assignment.epoch;
			};
			await bootstrapAssignment(fleet.register, "c0");
			let views: number[] = [1];
			let lostSinceRepair = 0;
			for (let step = 0; step < 120; step += 1) {
				const roll = random.next();
				for (const backend of fleet.backends)
					backend.down = random.next() < 0.15;
				if (roll < 0.45) {
					const outcome = await proposeAssignment(fleet.register, {
						expectedEpoch: random.pick(views),
						value: writer(random.pick(ids)),
						decidedBy: `p${step}`,
						nowMs: step,
					});
					if (outcome.status === "decided")
						views = [...views.slice(-3), outcome.assignment.epoch];
				} else if (roll < 0.7) {
					observe(await completeAssignment(fleet.register));
				} else if (roll < 0.85) {
					for (const backend of fleet.backends) backend.down = false;
					const repaired = await completeAssignment(fleet.register);
					observe(repaired);
					await rejoinAssignmentReplicas(fleet.register);
					if (repaired.status === "current" && repaired.holders.length === size)
						lostSinceRepair = 0;
				} else if (lostSinceRepair < Math.floor(size / 2)) {
					// Lose a log only when every member holds the current entry.
					for (const backend of fleet.backends) backend.down = false;
					const now = resolveAssignment(
						ids,
						await readAssignmentReplies(fleet.register),
					);
					if (now.status === "current" && now.holders.length === size) {
						random.pick(fleet.backends).wipe();
						lostSinceRepair += 1;
						wipes += 1;
					}
				}
				observe(await readCurrentAssignment(fleet.register));
			}
			expect(highest).toBeGreaterThan(1);
		}
		expect(wipes).toBeGreaterThan(5);
	});
});
