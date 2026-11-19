import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromBinary, fromJsonString, toBinary } from "@bufbuild/protobuf";
import { afterAll, describe, expect, it } from "vitest";
import { SloEvaluationRecordSchema } from "../src/_generated/slo_pb.js";
import type { JsonObject } from "../src/json.js";
import { parseSloDefinition } from "../src/ports/slo.js";
import { createBuiltInSloDefinitions } from "../src/ports/slo-builtins.js";
import {
	computeSloStatus,
	type SliSample,
} from "../src/ports/slo-computation.js";
import { sloFixture } from "./slo-fixture.js";

const now = "2026-06-26T04:00:00Z";
const cue =
	process.env.HOBO_CUE_BIN ||
	fileURLToPath(
		new URL(
			`../../../.tools/cue/v0.14.0/${process.platform === "win32" ? "cue.exe" : "cue"}`,
			import.meta.url,
		),
	);
const schema = fileURLToPath(
	new URL("../data-models/slo.cue", import.meta.url),
);
const directory = mkdtempSync(join(tmpdir(), "hobo-slo-evaluation-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function definition(spec: JsonObject = {}) {
	const fixture = sloFixture();
	return parseSloDefinition({
		...fixture,
		spec: {
			...fixture.spec,
			timeWindow: { duration: "1h", isRolling: true },
			burnRateThresholds: [],
			...spec,
		},
	});
}
function source(samples: readonly SliSample[]) {
	return { readRatioSamples: () => samples };
}
function sample(time: string, good: number, total: number): SliSample {
	return { time, good, total };
}

describe("SLO computation", () => {
	it("binds standard SLOs to caller-provided telemetry queries", () => {
		const definitions = createBuiltInSloDefinitions({
			deploySuccess: {
				good: { query: "deployment_success" },
				total: { query: "deployment_total" },
			},
			controlPlaneAvailability: {
				good: { query: "request_success" },
				total: { query: "request_total" },
			},
		});
		expect(definitions.map((item) => item.metadata.name)).toEqual([
			"deploy-success-rate",
			"control-plane-availability",
		]);
		expect(
			definitions[0]?.spec.indicator.ratioMetric.good.telemetry.query,
		).toBe("deployment_success");
		expect(
			definitions[1]?.spec.indicator.ratioMetric.total.telemetry.query,
		).toBe("request_total");
	});
	it("calculates occurrence budgets for every objective and emits valid protobuf and CUE", async () => {
		const evaluation = await computeSloStatus({
			definition: definition({
				objectives: [
					{ displayName: "strict", target: 0.99 },
					{ displayName: "relaxed", target: 0.9 },
				],
			}),
			sliSource: source([sample("2026-06-26T03:59:00Z", 985, 1000)]),
			now,
		});
		expect(evaluation.status).toBe("budget-exhausted");
		expect(evaluation.objectives.map((item) => item.status)).toEqual([
			"budget-exhausted",
			"healthy",
		]);
		expect(evaluation.objectives[0]?.window.burnRate).toBeCloseTo(1.5);
		expect(evaluation.objectives[1]?.window.remainingBudgetRatio).toBeCloseTo(
			0.85,
		);
		const message = fromJsonString(
			SloEvaluationRecordSchema,
			JSON.stringify(evaluation),
		);
		expect(
			fromBinary(
				SloEvaluationRecordSchema,
				toBinary(SloEvaluationRecordSchema, message),
			).objectives,
		).toHaveLength(2);
		const path = join(directory, "evaluation.json");
		writeFileSync(path, JSON.stringify(evaluation));
		const vet = spawnSync(
			cue,
			["vet", "-c", "-d", "#SloEvaluationRecord", schema, path],
			{ encoding: "utf8" },
		);
		expect(vet.stderr).toBe("");
		expect(vet.status).toBe(0);
	});

	it("counts time slices and weights ratio slices equally despite uneven traffic", async () => {
		const samples = [
			sample("2026-06-26T03:57:00Z", 100, 100),
			sample("2026-06-26T03:58:00Z", 100, 100),
			sample("2026-06-26T03:59:00Z", 0, 1),
			sample("2026-06-26T04:00:00Z", 90, 100),
		];
		const common = { timeWindow: { duration: "4m", isRolling: true } };
		const slices = await computeSloStatus({
			definition: definition({
				...common,
				budgetingMethod: "Timeslices",
				objectives: [
					{
						displayName: "availability",
						target: 0.8,
						timeSliceWindow: "1m",
						timeSliceTarget: 0.9,
					},
				],
			}),
			sliSource: source(samples),
			now,
		});
		const ratios = await computeSloStatus({
			definition: definition({
				...common,
				budgetingMethod: "RatioTimeslices",
				objectives: [
					{ displayName: "availability", target: 0.8, timeSliceWindow: "1m" },
				],
			}),
			sliSource: source(samples),
			now,
		});
		expect(slices.objectives[0]?.window).toMatchObject({
			good: 3,
			total: 4,
			slices: 4,
			remainingBudgetRatio: 0,
		});
		expect(ratios.objectives[0]?.window.good).toBeCloseTo(2.9);
		expect(ratios.objectives[0]?.window.total).toBe(4);
	});

	it("does not count a missing or zero-traffic slice as healthy", async () => {
		const value = definition({
			timeWindow: { duration: "2m", isRolling: true },
			budgetingMethod: "Timeslices",
			objectives: [
				{
					displayName: "availability",
					target: 0.9,
					timeSliceWindow: "1m",
					timeSliceTarget: 0.9,
				},
			],
		});
		for (const samples of [
			[sample("2026-06-26T04:00:00Z", 1, 1)],
			[
				sample("2026-06-26T03:59:00Z", 0, 0),
				sample("2026-06-26T04:00:00Z", 1, 1),
			],
		]) {
			const result = await computeSloStatus({
				definition: value,
				sliSource: source(samples),
				now,
			});
			expect(result.status).toBe("no-data");
		}
	});

	it("evaluates burn windows with half-open boundaries and does not hide missing recent data", async () => {
		const value = definition({
			burnRateThresholds: [
				{
					name: "fast",
					threshold: 2,
					lookbackWindow: "5m",
					samplingInterval: "1m",
				},
			],
		});
		const burning = await computeSloStatus({
			definition: value,
			sliSource: source([
				sample("2026-06-26T03:55:00Z", 0, 100),
				sample("2026-06-26T03:59:00Z", 98, 100),
			]),
			now,
		});
		expect(burning.objectives[0]?.burnWindows[0]?.triggered).toBe(true);
		expect(burning.objectives[0]?.burnWindows[0]?.window.total).toBe(100);
		const missing = await computeSloStatus({
			definition: value,
			sliSource: source([sample("2026-06-26T03:54:00Z", 100, 100)]),
			now,
		});
		expect(missing.status).toBe("no-data");
	});

	it("evaluates fast and slow burn windows independently", async () => {
		const value = definition({
			burnRateThresholds: [
				{
					name: "fast",
					threshold: 14.4,
					lookbackWindow: "5m",
					samplingInterval: "1m",
				},
				{
					name: "slow",
					threshold: 2,
					lookbackWindow: "1h",
					samplingInterval: "5m",
				},
			],
		});
		const samples = Array.from({ length: 60 }, (_, index) =>
			sample(
				new Date(Date.parse(now) - index * 60_000).toISOString(),
				980,
				1000,
			),
		);
		const result = await computeSloStatus({
			definition: value,
			sliSource: source(samples),
			now,
		});
		expect(
			result.objectives[0]?.burnWindows.map((item) => [
				item.name,
				item.triggered,
			]),
		).toEqual([
			["fast", false],
			["slow", true],
		]);
	});

	it("fails closed for stale, invalid, and zero-budget observations", async () => {
		const stale = await computeSloStatus({
			definition: definition(),
			sliSource: source([sample("2026-06-26T03:30:00Z", 1, 1)]),
			now,
		});
		const invalid = await computeSloStatus({
			definition: definition(),
			sliSource: source([sample("2026-06-26T03:59:00Z", 2, 1)]),
			now,
		});
		const zeroBudget = await computeSloStatus({
			definition: definition({
				objectives: [{ displayName: "perfect", target: 1 }],
			}),
			sliSource: source([sample("2026-06-26T03:59:00Z", 1, 1)]),
			now,
		});
		expect([stale.status, invalid.status, zeroBudget.status]).toEqual([
			"stale",
			"invalid-sli",
			"no-error-budget",
		]);
	});

	it("retains a small positive budget instead of rounding it to exhaustion", async () => {
		const result = await computeSloStatus({
			definition: definition(),
			sliSource: source([
				sample("2026-06-26T03:59:00Z", 99_000_000_000_001, 100_000_000_000_000),
			]),
			now,
		});
		expect(result.status).toBe("healthy");
		expect(result.objectives[0]?.window.remainingBudgetRatio).toBeGreaterThan(
			0,
		);
	});

	it("recognizes exact depletion and preserves tiny valid counts", async () => {
		const exact = await computeSloStatus({
			definition: definition(),
			sliSource: source([sample(now, 9900, 10000)]),
			now,
		});
		const tiny = await computeSloStatus({
			definition: definition(),
			sliSource: source([sample(now, 9.95e-8, 1e-7)]),
			now,
		});
		expect(exact.status).toBe("budget-exhausted");
		expect(exact.objectives[0]?.window.remainingBudgetRatio).toBe(0);
		expect(tiny.objectives[0]?.window.remainingBudgetRatio).toBeCloseTo(0.5);
	});

	it("rejects overflow and compares thresholds without rounding the burn rate", async () => {
		await expect(
			computeSloStatus({
				definition: definition(),
				sliSource: source([
					sample(now, Number.MAX_VALUE, Number.MAX_VALUE),
					sample(now, Number.MAX_VALUE, Number.MAX_VALUE),
				]),
				now,
			}),
		).rejects.toThrow(/overflow/u);
		const value = definition({
			burnRateThresholds: [
				{
					name: "double",
					threshold: 2,
					lookbackWindow: "5m",
					samplingInterval: "1m",
				},
			],
		});
		const below = await computeSloStatus({
			definition: value,
			sliSource: source([sample(now, 980.004, 1000)]),
			now,
		});
		expect(below.objectives[0]?.burnWindows[0]?.triggered).toBe(false);
		const nearPerfect = definition({
			objectives: [{ displayName: "perfect", target: 1 - Number.EPSILON }],
			burnRateThresholds: [
				{
					name: "double",
					threshold: 2,
					lookbackWindow: "5m",
					samplingInterval: "1m",
				},
			],
		});
		const nearPerfectResult = await computeSloStatus({
			definition: nearPerfect,
			sliSource: source([sample(now, 1 - Number.EPSILON, 1)]),
			now,
		});
		expect(nearPerfectResult.objectives[0]?.burnWindows[0]?.triggered).toBe(
			false,
		);
	});

	it("uses local calendar boundaries across daylight saving and preserves a month-end anchor", async () => {
		const day = definition({
			timeWindow: {
				duration: "1d",
				isRolling: false,
				calendar: {
					startTime: "2026-03-01T00:00:00",
					timeZone: "America/Chicago",
				},
			},
		});
		const dayResult = await computeSloStatus({
			definition: day,
			sliSource: source([sample("2026-03-09T04:00:00Z", 1, 1)]),
			now: "2026-03-09T04:30:00Z",
			maxStaleness: "1h",
		});
		expect(dayResult.objectives[0]?.window.startTime).toBe(
			"2026-03-08T06:00:00.000Z",
		);
		const month = definition({
			timeWindow: {
				duration: "1M",
				isRolling: false,
				calendar: {
					startTime: "2026-01-31T00:00:00",
					timeZone: "America/Chicago",
				},
			},
		});
		const monthResult = await computeSloStatus({
			definition: month,
			sliSource: source([sample("2026-04-29T12:00:00Z", 1, 1)]),
			now: "2026-04-29T12:01:00Z",
		});
		expect(monthResult.objectives[0]?.window.startTime).toBe(
			"2026-03-31T05:00:00.000Z",
		);
	});
});
