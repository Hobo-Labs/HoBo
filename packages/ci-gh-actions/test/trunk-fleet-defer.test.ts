import { describe, expect, it } from "vitest";
import {
	evaluateMainTrunkFleetDefer,
	trunkWaitFleetDeferEligible,
	type TrunkWaitState,
} from "../src/trunk-wait.js";

const deferMs = 45_000;
const nowMs = 100_000;

const wait = (reason: TrunkWaitState["reason"], ageMs: number): TrunkWaitState => ({
	sinceMs: nowMs - ageMs,
	logged: true,
	reason,
});

const reasons = [
	"host-available",
	"memory-budget",
	"trunk-pr-cap",
	"host-pressure",
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
