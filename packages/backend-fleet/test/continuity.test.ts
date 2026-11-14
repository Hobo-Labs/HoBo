import { describe, expect, it } from "vitest";

import {
	type ContinuityRequest,
	continuityBudgetCheck,
	continuityFleetPlan,
	continuityShortfalls,
	DEFAULT_FLEET_POLICY,
	MIN_COPY_INTERVAL_MS,
} from "../src/index.js";

const standard: ContinuityRequest = {
	tier: "standard",
	onLoss: "restore",
	recoveryPointMs: 5 * 60_000,
	failoverAfterMs: 60_000,
	standbys: 1,
	migration: "continuous",
	backupEveryMs: 86_400_000,
	backupsKept: 7,
};

describe("continuityFleetPlan", () => {
	it("copies every half recovery point and fails over on the declared delay", () => {
		const plan = continuityFleetPlan(standard);
		expect(plan.fleet.rpoMs).toBe(300_000);
		expect(plan.fleet.failoverAfterMs).toBe(60_000);
		expect(plan.copy).toBe("snapshot");
		expect(plan.copyEveryMs).toBe(150_000);
		expect(plan.fleet.minDwellMs).toBe(DEFAULT_FLEET_POLICY.minDwellMs);
	});

	it("never copies more often than the floor", () => {
		expect(
			continuityFleetPlan({ ...standard, recoveryPointMs: 2_000 }).copyEveryMs,
		).toBe(MIN_COPY_INTERVAL_MS);
	});

	it("on-failure never makes a planned switch", () => {
		expect(
			continuityFleetPlan({ ...standard, migration: "on-failure" }).fleet
				.minDwellMs,
		).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("rebuildable state moves cold and copies nothing", () => {
		const plan = continuityFleetPlan({
			...standard,
			tier: "rebuildable",
			onLoss: "rebuild",
			recoveryPointMs: 0,
			standbys: 0,
		});
		expect(plan.copy).toBe("cold");
		expect(plan.copyEveryMs).toBe(0);
	});
});

describe("continuityBudgetCheck", () => {
	it("refuses a period over the declared ceiling and defers otherwise", () => {
		const check = continuityBudgetCheck(
			continuityFleetPlan({ ...standard, monthlyBudgetMicros: 5_000_000 }),
		);
		const ask = { backend: "b", measurements: [], nowMs: 0 };
		expect(check({ ...ask, costBoundMicros: 6_000_000 }).ok).toBe(false);
		expect(check({ ...ask, costBoundMicros: 0 }).ok).toBe(true);
	});
});

describe("continuityShortfalls", () => {
	it("reports a fleet that cannot keep the promise", () => {
		const plan = continuityFleetPlan(standard);
		expect(
			continuityShortfalls(plan, { standbys: 0, tickEveryMs: 60_000, vendors: 1 }).map(
				(s) => s.code,
			),
		).toEqual(["continuity-standbys-short"]);
		expect(
			continuityShortfalls(plan, {
				standbys: 1,
				tickEveryMs: 900_000,
				vendors: 1,
			}).map((s) => s.code),
		).toEqual([
			"continuity-copy-too-slow",
			"continuity-no-quorum",
			"continuity-no-vendor-diversity",
		]);
		expect(
			continuityShortfalls(plan, {
				standbys: 1,
				tickEveryMs: 60_000,
				vendors: 2,
				witnesses: 1,
			}),
		).toEqual([]);
	});
});
