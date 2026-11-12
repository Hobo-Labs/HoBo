import { describe, expect, it } from "vitest";
import {
	effectiveTrunkFleetDeferMs,
	evaluateMainTrunkFleetDefer,
	PEER_PRESENT_TRUNK_HEADROOM_FLEET_DEFER_MS,
	type TrunkWaitState,
	trunkWaitFleetDeferEligible,
} from "../src/trunk-wait.js";

const deferMs = 45_000;
const nowMs = 100_000;

const wait = (
	reason: TrunkWaitState["reason"],
	ageMs: number,
): TrunkWaitState => ({
	sinceMs: nowMs - ageMs,
	logged: true,
	reason,
});

const reasons = [
	"host-available",
	"memory-headroom",
	"memory-budget",
	"trunk-pr-cap",
	"host-pressure",
	"cpu-contention",
	"storage",
	"headroom",
] as const satisfies readonly TrunkWaitState["reason"][];

describe("trunkWaitFleetDeferEligible", () => {
	for (const reason of reasons) {
		it(`defers after the window for ${reason}`, () => {
			expect(
				trunkWaitFleetDeferEligible(wait(reason, deferMs + 1), deferMs, nowMs),
			).toBe(true);
		});
	}

	it("rejects fleet-capacity waits", () => {
		expect(
			trunkWaitFleetDeferEligible(
				wait("fleet-capacity", deferMs + 1),
				deferMs,
				nowMs,
			),
		).toBe(false);
	});
});

describe("effectiveTrunkFleetDeferMs", () => {
	it("shortens the window when peers report absorb slots", () => {
		expect(effectiveTrunkFleetDeferMs(deferMs, 2)).toBe(
			PEER_PRESENT_TRUNK_HEADROOM_FLEET_DEFER_MS,
		);
		expect(effectiveTrunkFleetDeferMs(deferMs, 0)).toBe(deferMs);
	});
});

describe("evaluateMainTrunkFleetDefer", () => {
	it("defers main shards when peer capacity exists and wait expired", () => {
		const decision = evaluateMainTrunkFleetDefer({
			jobName: "Main workspace test shard 0",
			isMainTrunkJob: true,
			priorWait: wait("memory-budget", 60_000),
			deferMs,
			nowMs,
			trunkSlots: 1,
			localTrunkReserved: 0,
			fleetWitness: { hoboFreeSlots: 0, arcFreeSlots: 2 },
		});
		expect(decision.action).toBe("defer");
		expect(decision.peerAbsorbSlots).toBe(2);
	});

	it("defers plan and deps immediately on memory-headroom when peers exist", () => {
		for (const jobName of [
			"Main workspace plan",
			"CI deps layer (pnpm)",
		] as const) {
			const decision = evaluateMainTrunkFleetDefer({
				jobName,
				isMainTrunkJob: true,
				priorWait: wait("memory-headroom", 1_000),
				deferMs,
				nowMs,
				trunkSlots: 1,
				localTrunkReserved: 0,
				fleetWitness: { hoboFreeSlots: 0, arcFreeSlots: 1, meshFreeSlots: 0 },
			});
			expect(decision.action).toBe("defer");
			expect(decision.waitReason).toBe("memory-headroom");
		}
	});

	it("defers cpu-contention immediately when peer absorb slots exist", () => {
		const decision = evaluateMainTrunkFleetDefer({
			jobName: "Main workspace test shard 3",
			isMainTrunkJob: true,
			priorWait: wait("cpu-contention", 1_000),
			deferMs,
			nowMs,
			trunkSlots: 1,
			localTrunkReserved: 1,
			fleetWitness: { hoboFreeSlots: 0, arcFreeSlots: 2, meshFreeSlots: 0 },
		});
		expect(decision.action).toBe("defer");
		expect(decision.waitReason).toBe("cpu-contention");
		expect(decision.shardIndex).toBe(3);
		expect(decision.deferMs).toBe(PEER_PRESENT_TRUNK_HEADROOM_FLEET_DEFER_MS);
	});

	it("defers overflow shards when local trunk slots are full and peers exist", () => {
		const decision = evaluateMainTrunkFleetDefer({
			jobName: "Main workspace test shard 3",
			isMainTrunkJob: true,
			priorWait: undefined,
			deferMs,
			nowMs,
			trunkSlots: 2,
			localTrunkReserved: 2,
			fleetWitness: { hoboFreeSlots: 0, arcFreeSlots: 1, meshFreeSlots: 0 },
		});
		expect(decision.action).toBe("defer");
		expect(decision.holdReason).toBeUndefined();
	});

	it("does not treat the box as slot-full while memory-parallel trunk launches remain", () => {
		const decision = evaluateMainTrunkFleetDefer({
			jobName: "Main workspace test shard 2",
			isMainTrunkJob: true,
			priorWait: undefined,
			deferMs,
			nowMs,
			trunkSlots: 1,
			parallelTrunkLaunchCapacity: 3,
			localTrunkReserved: 1,
			fleetWitness: { hoboFreeSlots: 0, arcFreeSlots: 2, meshFreeSlots: 2 },
		});
		expect(decision.action).toBe("hold");
		expect(decision.holdReason).toBe("no-wait");
	});

	it("holds when peer capacity is zero", () => {
		const decision = evaluateMainTrunkFleetDefer({
			jobName: "Main workspace test shard 1",
			isMainTrunkJob: true,
			priorWait: wait("host-available", 120_000),
			deferMs,
			nowMs,
			trunkSlots: 1,
			localTrunkReserved: 0,
			fleetWitness: { hoboFreeSlots: 0, arcFreeSlots: 0, meshFreeSlots: 0 },
		});
		expect(decision.action).toBe("hold");
		expect(decision.holdReason).toBe("no-peer-capacity");
		expect(decision.arcFreeSlots).toBe(0);
	});
});
