import { describe, expect, it } from "vitest";
import type { InsightJob, InsightRun } from "../src/insights/types.js";
import { type MinuteRate, usageReport } from "../src/insights/usage.js";

const DAY = 86_400_000;
const MIN = 60_000;
/** 2026-11-02T00:00:00Z */
const DAY_ONE = Date.UTC(2026, 10, 2);

// A test rate, not GitHub's: the report never carries a price of its own.
const RATE: MinuteRate = {
	usdPerMinute: 0.01,
	source: "test fixture",
	readOn: "2026-11-17",
};

function job(
	id: number,
	labels: readonly string[],
	startedAtMs: number,
	runMs: number,
	extra: Partial<InsightJob> = {},
): InsightJob {
	return {
		id,
		name: `job-${id}`,
		labels,
		conclusion: "success",
		queuedAtMs: startedAtMs - 1_000,
		startedAtMs,
		completedAtMs: startedAtMs + runMs,
		steps: [],
		billed: false,
		...extra,
	};
}

function run(
	id: number,
	jobs: readonly InsightJob[],
	repository = "octo/app",
): InsightRun {
	return {
		id,
		attempt: 1,
		repository,
		workflow: "CI",
		workflowPath: ".github/workflows/ci.yml",
		event: "push",
		branch: "main",
		defaultBranch: "main",
		headSha: "0123456789abcdef0123456789abcdef01234567",
		actor: "octocat",
		conclusion: "success",
		createdAtMs: jobs[0]?.queuedAtMs ?? DAY_ONE,
		jobs,
	};
}

describe("usageReport", () => {
	const runs = [
		run(1, [
			// Billed: 90 s rounds up to 2 minutes.
			job(11, ["ubuntu-24.04"], DAY_ONE + 1_000, 90_000, { billed: true }),
			// Billed and short: 15 s, billed a whole minute; 0.75 wasted.
			job(12, ["ubuntu-24.04"], DAY_ONE + 2_000, 15_000, { billed: true }),
			// Kept off GitHub: 3.5 minutes on a fleet runner, GitHub would bill 4.
			job(13, ["hobo"], DAY_ONE + 3_000, 3.5 * MIN),
			// A relay job a relay answered: no billed minute, GitHub's minimum saved.
			job(14, ["hobo-relay"], DAY_ONE + 500, 1_000, { relay: true }),
		]),
		run(2, [
			// Next day, billed: 5 minutes.
			job(21, ["ubuntu-24.04"], DAY_ONE + DAY + 1_000, 5 * MIN, {
				billed: true,
			}),
			// Never started: counts nowhere.
			{
				...job(22, ["ubuntu-24.04"], DAY_ONE + DAY, 0, { billed: true }),
				startedAtMs: undefined,
				completedAtMs: undefined,
			},
			// A relay job run on a GitHub-hosted runner (job mode): saves nothing.
			job(23, ["ubuntu-24.04"], DAY_ONE + DAY + 2_000, 20_000, {
				relay: true,
				billed: true,
			}),
		]),
	];

	const report = usageReport(runs, { githubRate: RATE, included: undefined });

	it("adds billed minutes the way GitHub bills them", () => {
		// 2 + 1 + 5 + 1 (the job-mode relay job is billed too).
		expect(report.billedMinutes).toBe(9);
		expect(report.billedUsd).toBeCloseTo(0.09);
	});

	it("names the waste in billed jobs under a minute", () => {
		expect(report.shortJobs).toBe(2);
		expect(report.wasteMinutes).toBeCloseTo(0.75 + (1 - 20 / 60));
	});

	it("prices minutes kept off GitHub-hosted runners at GitHub's rate", () => {
		expect(report.keptMinutes).toBe(4);
		expect(report.keptUsd).toBeCloseTo(0.04);
		expect(report.rate).toEqual(RATE);
	});

	it("counts relay jobs answered without a billed minute", () => {
		expect(report.relayJobsAnswered).toBe(1);
		expect(report.relaySavedMinutes).toBe(1);
		expect(report.relaySavedUsd).toBeCloseTo(0.01);
	});

	it("groups minutes by runner type", () => {
		expect(
			report.runners.map((row) => [
				row.runner,
				row.hosted,
				row.jobs,
				row.billedMinutes,
				row.keptMinutes,
			]),
		).toEqual([
			["ubuntu-24.04", true, 4, 9, 0],
			["hobo", false, 1, 0, 4],
			["hobo-relay", false, 1, 0, 0],
		]);
	});

	it("splits everything per UTC day, oldest first", () => {
		expect(
			report.days.map((day) => [
				day.day,
				day.billedMinutes,
				day.shortJobs,
				day.keptMinutes,
				day.relayJobsAnswered,
			]),
		).toEqual([
			["2026-11-02", 3, 1, 4, 1],
			["2026-11-03", 6, 1, 0, 0],
		]);
	});

	it("measures nothing against the included amount when it was not read", () => {
		expect(report.included).toBeUndefined();
	});

	it("shows minutes against the included amount and the burn", () => {
		const withIncluded = usageReport(runs, {
			githubRate: RATE,
			included: { usedMinutes: 1_900, includedMinutes: 2_000 },
		});
		expect(withIncluded.included).toEqual({
			usedMinutes: 1_900,
			includedMinutes: 2_000,
			remainingMinutes: 100,
			// 9 billed minutes over two days.
			burnPerDay: 4.5,
			daysLeft: 100 / 4.5,
		});
		const measuredBurn = usageReport(runs, {
			githubRate: RATE,
			included: { usedMinutes: 2_100, includedMinutes: 2_000, burnPerHour: 1 },
		});
		expect(measuredBurn.included?.remainingMinutes).toBe(0);
		expect(measuredBurn.included?.burnPerDay).toBe(24);
		expect(measuredBurn.included?.daysLeft).toBe(0);
	});

	it("prices kept minutes at nothing in a public repository", () => {
		const open = usageReport(runs, {
			githubRate: RATE,
			included: undefined,
			publicRepositories: new Set(["Octo/App"]),
		});
		expect(open.keptMinutes).toBe(4);
		expect(open.keptUsd).toBe(0);
		expect(open.relaySavedUsd).toBe(0);
	});

	it("is empty for no runs and has no burn to project", () => {
		const empty = usageReport([], {
			githubRate: RATE,
			included: { usedMinutes: 0, includedMinutes: 2_000 },
		});
		expect(empty.billedMinutes).toBe(0);
		expect(empty.days).toEqual([]);
		expect(empty.included?.daysLeft).toBeUndefined();
	});

	it("refuses a rate with no source or a bad date", () => {
		expect(() =>
			usageReport(runs, {
				githubRate: { ...RATE, source: " " },
				included: undefined,
			}),
		).toThrow(/source/);
		expect(() =>
			usageReport(runs, {
				githubRate: { ...RATE, readOn: "yesterday" },
				included: undefined,
			}),
		).toThrow(/readOn/);
		expect(() =>
			usageReport(runs, {
				githubRate: { ...RATE, usdPerMinute: -1 },
				included: undefined,
			}),
		).toThrow(/usdPerMinute/);
	});

	it("counts a job under a custom short-job threshold", () => {
		const strict = usageReport(runs, {
			githubRate: RATE,
			included: undefined,
			shortJobMs: 2 * MIN,
		});
		// The 90 s job is now short too: 2 billed, 1.5 run.
		expect(strict.shortJobs).toBe(3);
	});
});
