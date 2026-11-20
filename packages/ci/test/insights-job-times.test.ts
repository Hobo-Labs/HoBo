import { describe, expect, it } from "vitest";
import {
	DEFAULT_JOB_TIME_OPTIONS,
	DEFAULT_MISSED_AFTER_MS,
	type JobTimes,
	jobTimes,
	median,
	percentile,
	type RunnerTimes,
	runnerTimes,
	type WorkflowTimes,
	workflowTimes,
} from "../src/insights/job-times.js";
import type { InsightJob, InsightRun } from "../src/insights/types.js";

const MIN = 60_000;

function ran(
	name: string,
	waitMs: number,
	runMs: number,
	extra: Partial<InsightJob> = {},
): InsightJob {
	return {
		id: 1,
		name,
		labels: ["ubuntu-latest"],
		conclusion: "success",
		queuedAtMs: 0,
		startedAtMs: waitMs,
		completedAtMs: waitMs + runMs,
		steps: [],
		billed: false,
		...extra,
	};
}

function queued(name: string, extra: Partial<InsightJob> = {}): InsightJob {
	return {
		id: 1,
		name,
		labels: ["ubuntu-latest"],
		conclusion: "unknown",
		queuedAtMs: 0,
		steps: [],
		billed: false,
		...extra,
	};
}

function run(partial: Partial<InsightRun> = {}): InsightRun {
	return {
		id: 1,
		attempt: 1,
		repository: "acme/app",
		workflow: "CI",
		workflowPath: ".github/workflows/ci.yml",
		event: "push",
		branch: "main",
		defaultBranch: "main",
		headSha: "sha-1",
		actor: "sam",
		conclusion: "success",
		createdAtMs: 0,
		jobs: [],
		...partial,
	};
}

function samples(
	count: number,
	runMs: number,
	label = "ubuntu-latest",
	name = "unit",
): InsightJob[] {
	return Array.from({ length: count }, () =>
		ran(name, 0, runMs, { labels: [label] }),
	);
}

function only<T>(values: readonly T[]): T {
	const [first] = values;
	if (first === undefined || values.length !== 1) {
		throw new Error(`expected one value, got ${values.length}`);
	}
	return first;
}

describe("percentile", () => {
	const oneToTen = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

	it("is undefined for no values", () => {
		expect(percentile([], 50)).toBeUndefined();
		expect(median([])).toBeUndefined();
	});

	it("is undefined for a percentile outside (0, 100]", () => {
		expect(percentile(oneToTen, 0)).toBeUndefined();
		expect(percentile(oneToTen, -1)).toBeUndefined();
		expect(percentile(oneToTen, 100.1)).toBeUndefined();
		expect(percentile(oneToTen, Number.NaN)).toBeUndefined();
	});

	it("picks the nearest rank", () => {
		expect(percentile(oneToTen, 1)).toBe(1);
		expect(percentile(oneToTen, 10)).toBe(1);
		expect(percentile(oneToTen, 10.1)).toBe(2);
		expect(percentile(oneToTen, 50)).toBe(5);
		expect(percentile(oneToTen, 70)).toBe(7);
		expect(percentile(oneToTen, 90)).toBe(9);
		expect(percentile(oneToTen, 91)).toBe(10);
		expect(percentile(oneToTen, 100)).toBe(10);
	});

	it("returns the only value for any percentile", () => {
		expect(percentile([42], 1)).toBe(42);
		expect(percentile([42], 100)).toBe(42);
	});

	it("sorts the values itself and leaves the input alone", () => {
		const values = [30, 10, 20];
		expect(percentile(values, 100)).toBe(30);
		expect(median(values)).toBe(20);
		expect(values).toEqual([30, 10, 20]);
	});

	it("ignores values that are not finite numbers", () => {
		expect(median([Number.NaN, 5, Number.POSITIVE_INFINITY])).toBe(5);
		expect(median([Number.NaN])).toBeUndefined();
	});

	it("takes the lower of the two middle values as the median", () => {
		expect(median([1, 2, 3, 4])).toBe(2);
		expect(median([1, 2, 3])).toBe(2);
	});
});

describe("runnerTimes", () => {
	it("measures waits, run times and results per runner", () => {
		const times = runnerTimes([
			run({
				jobs: [
					ran("a", 10_000, 2 * MIN),
					ran("b", 30_000, 4 * MIN),
					ran("c", 20_000, 9 * MIN, { conclusion: "failure" }),
					ran("d", 40_000, 6 * MIN, { conclusion: "timed_out" }),
					ran("e", 50_000, MIN, { conclusion: "cancelled" }),
				],
			}),
		]);
		expect(times).toEqual<RunnerTimes[]>([
			{
				key: "ubuntu-latest",
				jobs: 5,
				started: 5,
				startedShare: 1,
				medianWaitMs: 30_000,
				medianRunMs: 2 * MIN,
				p90RunMs: 4 * MIN,
				successRate: 0.5,
			},
		]);
	});

	it("counts a job that ended without a runner as missed", () => {
		const [times] = runnerTimes([
			run({
				jobs: [
					ran("a", 0, MIN),
					queued("b", { conclusion: "cancelled", completedAtMs: 5 * MIN }),
				],
			}),
		]);
		expect(times).toMatchObject({ jobs: 2, started: 1, startedShare: 0.5 });
	});

	it("counts a job still queued as missed once it has waited too long", () => {
		const stillQueued = [run({ jobs: [ran("a", 0, MIN), queued("b")] })];
		const jobsAt = (nowMs: number): number | undefined =>
			runnerTimes(stillQueued, { nowMs })[0]?.jobs;
		expect(jobsAt(DEFAULT_MISSED_AFTER_MS - 1)).toBe(1);
		expect(jobsAt(DEFAULT_MISSED_AFTER_MS)).toBe(1);
		expect(jobsAt(DEFAULT_MISSED_AFTER_MS + 1)).toBe(2);
		expect(DEFAULT_MISSED_AFTER_MS).toBe(600_000);
	});

	it("honours a different waiting limit", () => {
		const stillQueued = [run({ jobs: [queued("b", { queuedAtMs: 1_000 })] })];
		expect(
			runnerTimes(stillQueued, { nowMs: 6_000, missedAfterMs: 5_000 }),
		).toEqual([]);
		expect(
			runnerTimes(stillQueued, { nowMs: 6_001, missedAfterMs: 5_000 }),
		).toMatchObject([{ jobs: 1, started: 0, startedShare: 0 }]);
	});

	it("never counts a queued job as missed without the time of the report", () => {
		expect(runnerTimes([run({ jobs: [queued("b")] })])).toEqual([]);
	});

	it("has no figures where nothing was measured", () => {
		const [times] = runnerTimes([
			run({
				jobs: [queued("b", { conclusion: "cancelled", completedAtMs: MIN })],
			}),
		]);
		expect(times).toEqual<RunnerTimes>({
			key: "ubuntu-latest",
			jobs: 1,
			started: 0,
			startedShare: 0,
			medianWaitMs: undefined,
			medianRunMs: undefined,
			p90RunMs: undefined,
			successRate: undefined,
		});
	});

	it("measures run time on successful jobs that finished only", () => {
		const running: InsightJob = { ...queued("b"), startedAtMs: 5_000 };
		const [times] = runnerTimes([
			run({
				jobs: [
					ran("a", 0, 9 * MIN, { conclusion: "failure" }),
					{ ...running, conclusion: "success" },
				],
			}),
		]);
		expect(times).toMatchObject({
			started: 2,
			medianRunMs: undefined,
			p90RunMs: undefined,
			successRate: 0.5,
		});
	});

	it("leaves out relay jobs and skipped jobs", () => {
		const times = runnerTimes([
			run({
				jobs: [
					ran("route", 0, MIN, { relay: true }),
					queued("optional", { conclusion: "skipped", completedAtMs: 0 }),
				],
			}),
		]);
		expect(times).toEqual([]);
	});

	it("lists the busiest runner first, then by key", () => {
		const on = (label: string): InsightJob =>
			ran("a", 0, MIN, { labels: [label] });
		const times = runnerTimes([
			run({
				jobs: [
					on("beta"),
					on("alpha"),
					on("gamma"),
					on("gamma"),
					ran("a", 0, MIN, { labels: ["self-hosted", "linux"] }),
				],
			}),
		]);
		expect(times.map((entry) => [entry.key, entry.jobs])).toEqual([
			["gamma", 2],
			["alpha", 1],
			["beta", 1],
			["linux, self-hosted", 1],
		]);
	});
});

describe("jobTimes", () => {
	it("publishes the default limits", () => {
		expect(DEFAULT_JOB_TIME_OPTIONS).toEqual({
			sampleCap: 50,
			enoughRuns: 20,
			fewRuns: 5,
			baselineKey: "ubuntu-latest",
			minSharedJobs: 3,
		});
	});

	it("measures a job per runner, fastest first", () => {
		const times = jobTimes([
			run({
				jobs: [
					...samples(5, 4 * MIN),
					...samples(5, 2 * MIN, "hobo"),
					ran("unit", 0, 10 * MIN, { labels: ["hobo"] }),
				],
			}),
		]);
		expect(times).toEqual<JobTimes[]>([
			{
				job: "unit",
				workflow: "CI",
				runners: [
					{
						key: "hobo",
						runs: 6,
						medianRunMs: 2 * MIN,
						p90RunMs: 10 * MIN,
						confidence: "few",
					},
					{
						key: "ubuntu-latest",
						runs: 5,
						medianRunMs: 4 * MIN,
						p90RunMs: 4 * MIN,
						confidence: "few",
					},
				],
				fastest: "hobo",
				speedup: [{ key: "hobo", ratio: 2 }],
			},
		]);
	});

	it("grades confidence by the number of runs", () => {
		const confidenceWith = (count: number): string | undefined =>
			only(jobTimes([run({ jobs: samples(count, MIN) })])).runners[0]
				?.confidence;
		expect(confidenceWith(1)).toBe("sparse");
		expect(confidenceWith(4)).toBe("sparse");
		expect(confidenceWith(5)).toBe("few");
		expect(confidenceWith(19)).toBe("few");
		expect(confidenceWith(20)).toBe("enough");
		expect(confidenceWith(21)).toBe("enough");
	});

	it("honours different confidence limits", () => {
		const [times] = jobTimes([run({ jobs: samples(3, MIN) })], {
			fewRuns: 2,
			enoughRuns: 3,
		});
		expect(times?.runners[0]?.confidence).toBe("enough");
	});

	it("measures only the newest runs up to the sample cap", () => {
		const old = samples(3, 60 * MIN);
		const recent = Array.from({ length: 2 }, (_, index) => ({
			...ran("unit", 0, MIN),
			startedAtMs: 100 * MIN + index,
			completedAtMs: 101 * MIN + index,
		}));
		const jobs = [...old, ...recent];
		const newestTwo = only(jobTimes([run({ jobs })], { sampleCap: 2 }));
		expect(newestTwo.runners[0]).toMatchObject({
			runs: 2,
			medianRunMs: MIN,
			p90RunMs: MIN,
		});
		const newestThree = only(jobTimes([run({ jobs })], { sampleCap: 3 }));
		expect(newestThree.runners[0]).toMatchObject({
			runs: 3,
			medianRunMs: MIN,
			p90RunMs: 60 * MIN,
		});
		const byDefault = only(jobTimes([run({ jobs: samples(51, MIN) })]));
		expect(byDefault.runners[0]?.runs).toBe(50);
	});

	it("keeps at least one run however small the cap", () => {
		const [times] = jobTimes([run({ jobs: samples(3, MIN) })], {
			sampleCap: 0,
		});
		expect(times?.runners[0]?.runs).toBe(1);
	});

	it("names the fastest runner among those that are not sparse", () => {
		const times = only(
			jobTimes([
				run({
					jobs: [
						...samples(4, MIN, "quick-but-sparse"),
						...samples(5, 3 * MIN, "steady"),
						...samples(5, 5 * MIN),
					],
				}),
			]),
		);
		expect(times.runners.map((runner) => runner.key)).toEqual([
			"quick-but-sparse",
			"steady",
			"ubuntu-latest",
		]);
		expect(times.fastest).toBe("steady");
	});

	it("names no fastest runner when every one is sparse", () => {
		const times = only(jobTimes([run({ jobs: samples(4, MIN) })]));
		expect(times.fastest).toBeUndefined();
	});

	it("breaks a tie on the median by runner key", () => {
		const times = only(
			jobTimes([
				run({
					jobs: [...samples(5, MIN, "beta"), ...samples(5, MIN, "alpha")],
				}),
			]),
		);
		expect(times.runners.map((runner) => runner.key)).toEqual([
			"alpha",
			"beta",
		]);
		expect(times.fastest).toBe("alpha");
	});

	it("compares with the baseline only when both have enough runs", () => {
		const speedupWith = (baseline: number, other: number) =>
			only(
				jobTimes([
					run({
						jobs: [
							...samples(baseline, 6 * MIN),
							...samples(other, 2 * MIN, "hobo"),
						],
					}),
				]),
			).speedup;
		expect(speedupWith(3, 3)).toEqual([{ key: "hobo", ratio: 3 }]);
		expect(speedupWith(2, 3)).toEqual([]);
		expect(speedupWith(3, 2)).toEqual([]);
		expect(speedupWith(4, 4)).toEqual([{ key: "hobo", ratio: 3 }]);
	});

	it("honours a different baseline and comparison limit", () => {
		const runs = [
			run({
				jobs: [
					...samples(1, 2 * MIN, "Hobo"),
					...samples(1, 6 * MIN),
					...samples(1, 4 * MIN, "arc"),
				],
			}),
		];
		expect(only(jobTimes(runs)).speedup).toEqual([]);
		expect(
			only(jobTimes(runs, { baselineKey: " hobo ", minSharedJobs: 1 })).speedup,
		).toEqual([
			{ key: "arc", ratio: 0.5 },
			{ key: "ubuntu-latest", ratio: 1 / 3 },
		]);
	});

	it("compares nothing without the baseline runner", () => {
		const times = only(jobTimes([run({ jobs: samples(5, MIN, "hobo") })]));
		expect(times.speedup).toEqual([]);
	});

	it("skips a runner whose median is zero", () => {
		const times = only(
			jobTimes([
				run({ jobs: [...samples(3, MIN), ...samples(3, 0, "instant")] }),
			]),
		);
		expect(times.speedup).toEqual([]);
	});

	it("leaves out failed, unfinished and relay jobs", () => {
		const running: InsightJob = {
			...queued("unit", { conclusion: "success" }),
			startedAtMs: 0,
		};
		const times = jobTimes([
			run({
				jobs: [
					ran("unit", 0, MIN, { conclusion: "failure" }),
					ran("route", 0, MIN, { relay: true }),
					running,
					queued("unit"),
				],
			}),
		]);
		expect(times).toEqual([]);
	});

	it("lists jobs by workflow, then by name", () => {
		const times = jobTimes([
			run({ workflow: "Release", jobs: samples(1, MIN, "hobo", "publish") }),
			run({
				jobs: [
					...samples(1, MIN, "hobo", "unit"),
					...samples(1, MIN, "hobo", "lint"),
				],
			}),
		]);
		expect(times.map((entry) => [entry.workflow, entry.job])).toEqual([
			["CI", "lint"],
			["CI", "unit"],
			["Release", "publish"],
		]);
	});
});

describe("workflowTimes", () => {
	const attempt = (
		durationMs: number,
		partial: Partial<InsightRun> = {},
	): InsightRun => run({ completedAtMs: durationMs, ...partial });

	it("measures how long successful attempts take", () => {
		const times = workflowTimes([
			attempt(4 * MIN),
			attempt(6 * MIN),
			attempt(8 * MIN),
			attempt(40 * MIN, { conclusion: "failure" }),
			attempt(50 * MIN, { conclusion: "timed_out" }),
			attempt(MIN, { conclusion: "cancelled" }),
			run({ conclusion: "unknown" }),
		]);
		expect(times).toEqual<WorkflowTimes[]>([
			{
				workflow: "CI",
				runs: 7,
				successRate: 0.6,
				medianMs: 6 * MIN,
				p90Ms: 8 * MIN,
				medianWaitMs: undefined,
				slowestJob: undefined,
			},
		]);
	});

	it("has no figures for a workflow that never ran to an outcome", () => {
		const [times] = workflowTimes([attempt(MIN, { conclusion: "cancelled" })]);
		expect(times).toEqual<WorkflowTimes>({
			workflow: "CI",
			runs: 1,
			successRate: undefined,
			medianMs: undefined,
			p90Ms: undefined,
			medianWaitMs: undefined,
			slowestJob: undefined,
		});
	});

	it("measures no duration for a successful attempt without a finish time", () => {
		const [times] = workflowTimes([run()]);
		expect(times).toMatchObject({ successRate: 1, medianMs: undefined });
	});

	it("never measures a negative duration", () => {
		const [times] = workflowTimes([
			run({ createdAtMs: 5_000, completedAtMs: 0 }),
		]);
		expect(times?.medianMs).toBe(0);
	});

	it("takes the median wait across jobs rather than summing each attempt", () => {
		const [times] = workflowTimes([
			attempt(MIN, {
				jobs: [
					ran("a", 10_000, MIN),
					ran("b", 20_000, MIN),
					ran("route", 500_000, MIN, { relay: true }),
					queued("c"),
				],
			}),
			attempt(MIN, {
				conclusion: "failure",
				jobs: [ran("a", 5_000, MIN, { conclusion: "failure" })],
			}),
			attempt(MIN, { jobs: [ran("a", 90_000, MIN)] }),
			attempt(MIN, { jobs: [queued("a")] }),
		]);
		expect(times?.medianWaitMs).toBe(10_000);
	});

	it("names the job with the highest median run time", () => {
		const [times] = workflowTimes([
			attempt(MIN, {
				jobs: [
					ran("unit", 0, 3 * MIN),
					ran("e2e", 0, 9 * MIN),
					ran("lint", 0, 30 * MIN, { conclusion: "failure" }),
					ran("route", 0, 40 * MIN, { relay: true }),
				],
			}),
			attempt(MIN, { jobs: [ran("unit", 0, 5 * MIN), ran("e2e", 0, 7 * MIN)] }),
		]);
		expect(times?.slowestJob).toBe("e2e");
	});

	it("breaks a tie for the slowest job by name", () => {
		const [times] = workflowTimes([
			attempt(MIN, {
				jobs: [
					ran("beta", 0, 5 * MIN),
					ran("alpha", 0, 5 * MIN),
					ran("gamma", 0, 5 * MIN),
					ran("quick", 0, MIN),
				],
			}),
		]);
		expect(times?.slowestJob).toBe("alpha");
	});

	it("lists the workflow with the most attempts first, then by name", () => {
		const times = workflowTimes([
			attempt(MIN, { workflow: "Release" }),
			attempt(MIN, { workflow: "Deploy" }),
			attempt(MIN, { workflow: "CI" }),
			attempt(MIN, { workflow: "CI" }),
		]);
		expect(times.map((entry) => [entry.workflow, entry.runs])).toEqual([
			["CI", 2],
			["Deploy", 1],
			["Release", 1],
		]);
	});
});
