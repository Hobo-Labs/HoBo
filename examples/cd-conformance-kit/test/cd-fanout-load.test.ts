// The CD fan-out load lane (plan 0024 WP20 Load): 10,000 Camps, one fan-out,
// p99 controller tick under 1 s. The Postgres-backed run binds the same
// harness to @hobo/storage-postgres when HOBO_TEST_POSTGRES_URL is set; this
// file proves the runner and the in-memory reference.
import { CD_FANOUT_LOAD_DEFAULTS, cdPercentile, runFanoutLoad } from "@hobo/conformance";
import { describe, expect, it } from "vitest";
import { refLoadHarness } from "../src/index.js";
import { failed, summary } from "./report.js";

describe("CD fan-out load", () => {
	it("10,000 Camps, one fan-out: completes with p99 tick under 1 s", async () => {
		const report = await runFanoutLoad(refLoadHarness());
		expect(summary(report)).toBe("");
		expect(CD_FANOUT_LOAD_DEFAULTS.camps).toBe(10_000);
		expect(report.stats.p99Ms).toBeLessThan(CD_FANOUT_LOAD_DEFAULTS.p99TickBudgetMs);
		expect(report.stats.ticks).toBeGreaterThan(1);
	});
	it("fails a controller whose tick scans the fleet", async () => {
		const report = await runFanoutLoad(refLoadHarness("scans-fleet-quadratically"), { camps: 2_000, p99TickBudgetMs: 0.01 });
		expect(failed(report)).toEqual(["p99TickUnderBudget"]);
	});
	it("fails a fan-out that never completes within the tick bound", async () => {
		const report = await runFanoutLoad(refLoadHarness(), { camps: 100, maxTicks: 2 });
		expect(failed(report)).toEqual(["fanoutCompletes"]);
	});
	it("computes nearest-rank percentiles", () => {
		expect(cdPercentile([5, 1, 3, 2, 4], 50)).toBe(3);
		expect(cdPercentile([5, 1, 3, 2, 4], 99)).toBe(5);
		expect(cdPercentile([], 99)).toBe(0);
	});
});
