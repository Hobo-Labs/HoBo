import { describe, expect, it } from "vitest";
import {
	CI_SIGNAL_IDS,
	type CiSignal,
	type CiSignalId,
	ciSignals,
	DEFAULT_SIGNAL_THRESHOLDS,
	isDocsPath,
	type SignalThresholds,
} from "../src/insights/signals.js";
import type {
	InsightJob,
	InsightRun,
	InsightStep,
} from "../src/insights/types.js";

const MIN = 60_000;

const SETUP: InsightStep = {
	name: "Set up job",
	number: 1,
	conclusion: "success",
};
const WORK: InsightStep = {
	name: "Run pnpm test",
	number: 2,
	conclusion: "success",
};

/** A job a runner took at `startMs`, with no wait, that finished at `endMs`. */
function ran(
	name: string,
	startMs: number,
	endMs: number,
	extra: Partial<InsightJob> = {},
): InsightJob {
	return {
		id: 1,
		name,
		labels: ["ubuntu-latest"],
		conclusion: "success",
		queuedAtMs: startMs,
		startedAtMs: startMs,
		completedAtMs: endMs,
		steps: [SETUP, WORK],
		billed: false,
		...extra,
	};
}

/** A job no runner has taken. */
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

function signalOf(
	runs: readonly InsightRun[],
	id: CiSignalId,
	options?: Partial<SignalThresholds>,
): CiSignal {
	const found = ciSignals(runs, options).signals.find(
		(signal) => signal.id === id,
	);
	if (found === undefined) throw new Error(`no signal ${id}`);
	return found;
}

describe("ciSignals", () => {
	it("reports the nine signals in their fixed order, each in its area", () => {
		const { totalJobMinutes, signals } = ciSignals([]);
		expect(totalJobMinutes).toBe(0);
		expect(signals.map((signal) => signal.id)).toEqual([...CI_SIGNAL_IDS]);
		expect(signals.map((signal) => [signal.id, signal.area])).toEqual([
			["no-concurrency", "cost"],
			["same-commit", "cost"],
			["short-jobs", "cost"],
			["queue-waits", "speed"],
			["slowest-job", "speed"],
			["flaky-jobs", "speed"],
			["runner-failures", "speed"],
			["docs-changes", "complexity"],
			["wide-fanout", "complexity"],
		]);
		for (const signal of signals) {
			expect(signal).toMatchObject({
				minutes: 0,
				occurrences: 0,
				shown: false,
				rows: [],
			});
		}
	});

	it("totals the run time of every job that started and finished", () => {
		const runs = [
			run({ jobs: [ran("a", 0, 3 * MIN), queued("b")] }),
			run({ id: 2, jobs: [ran("a", 0, 90_000)] }),
		];
		expect(ciSignals(runs).totalJobMinutes).toBe(4.5);
	});

	it("publishes the default thresholds", () => {
		expect(DEFAULT_SIGNAL_THRESHOLDS).toEqual({
			queueWaitMs: 60_000,
			slowestJobMs: 60_000,
			fanoutJobs: 10,
			shortJobMs: 60_000,
			minMinutes: 30,
			minShare: 0.01,
			maxRows: 5,
			minRowMinutes: 1,
		});
	});
});

describe("shown", () => {
	/** One job that waited `waitMs` for a runner and then ran for `runMs`. */
	const waited = (waitMs: number, runMs: number): InsightRun =>
		run({
			jobs: [ran("a", waitMs, waitMs + runMs, { queuedAtMs: 0 })],
		});

	it("needs at least minMinutes", () => {
		expect(signalOf([waited(30 * MIN, MIN)], "queue-waits").shown).toBe(true);
		expect(signalOf([waited(30 * MIN + 1, MIN)], "queue-waits").shown).toBe(
			true,
		);
		expect(signalOf([waited(30 * MIN - 1, MIN)], "queue-waits").shown).toBe(
			false,
		);
	});

	it("needs at least minShare of all job minutes", () => {
		const options = { minShare: 0.5 };
		expect(
			signalOf([waited(30 * MIN, 60 * MIN)], "queue-waits", options).shown,
		).toBe(true);
		expect(
			signalOf([waited(30 * MIN, 59 * MIN)], "queue-waits", options).shown,
		).toBe(true);
		expect(
			signalOf([waited(30 * MIN, 60 * MIN + 1)], "queue-waits", options).shown,
		).toBe(false);
	});

	it("applies the default one percent share", () => {
		expect(signalOf([waited(30 * MIN, 2_000 * MIN)], "queue-waits").shown).toBe(
			true,
		);
		expect(signalOf([waited(30 * MIN, 4_000 * MIN)], "queue-waits").shown).toBe(
			false,
		);
	});

	it("is never set for a signal with no occurrences", () => {
		const signal = signalOf([waited(0, MIN)], "queue-waits", {
			minMinutes: 0,
			minShare: 0,
		});
		expect(signal.occurrences).toBe(0);
		expect(signal.shown).toBe(false);
	});
});

describe("rows", () => {
	const waitedOn = (label: string, waitMs: number): InsightJob =>
		ran("a", waitMs, waitMs, { queuedAtMs: 0, labels: [label] });

	it("groups occurrences by key and sorts by minutes, then key", () => {
		const signal = signalOf(
			[
				run({
					jobs: [
						waitedOn("beta", 2 * MIN),
						waitedOn("alpha", 2 * MIN),
						waitedOn("gamma", 3 * MIN),
						waitedOn("gamma", 4 * MIN),
					],
				}),
			],
			"queue-waits",
		);
		expect(signal.rows).toEqual([
			{ key: "gamma", minutes: 7, occurrences: 2 },
			{ key: "alpha", minutes: 2, occurrences: 1 },
			{ key: "beta", minutes: 2, occurrences: 1 },
		]);
		expect(signal.minutes).toBe(11);
		expect(signal.occurrences).toBe(4);
	});

	it("names at most maxRows offenders but counts them all", () => {
		const jobs = ["a", "b", "c", "d", "e", "f"].map((label, index) =>
			waitedOn(label, (index + 2) * MIN),
		);
		const byDefault = signalOf([run({ jobs })], "queue-waits");
		expect(byDefault.rows.map((row) => row.key)).toEqual([
			"f",
			"e",
			"d",
			"c",
			"b",
		]);
		expect(byDefault.occurrences).toBe(6);
		expect(byDefault.minutes).toBe(27);

		const two = signalOf([run({ jobs })], "queue-waits", { maxRows: 2 });
		expect(two.rows.map((row) => row.key)).toEqual(["f", "e"]);
	});

	it("drops offenders under minRowMinutes", () => {
		const signal = signalOf(
			[
				run({
					jobs: [
						waitedOn("under", MIN - 1),
						waitedOn("exact", MIN),
						waitedOn("over", MIN + 1),
					],
				}),
			],
			"queue-waits",
			{ queueWaitMs: 0 },
		);
		expect(signal.rows.map((row) => row.key)).toEqual(["over", "exact"]);
		expect(signal.occurrences).toBe(3);
	});
});

describe("queue-waits", () => {
	const waited = (waitMs: number, extra: Partial<InsightJob> = {}) =>
		run({
			jobs: [ran("a", waitMs, waitMs + MIN, { queuedAtMs: 0, ...extra })],
		});

	it("counts a job that waited longer than queueWaitMs", () => {
		expect(signalOf([waited(MIN - 1)], "queue-waits").occurrences).toBe(0);
		expect(signalOf([waited(MIN)], "queue-waits").occurrences).toBe(0);
		const over = signalOf([waited(MIN + 1)], "queue-waits");
		expect(over.occurrences).toBe(1);
		expect(over.minutes).toBeCloseTo((MIN + 1) / MIN, 10);
	});

	it("honours a different threshold", () => {
		const options = { queueWaitMs: 5 * MIN };
		expect(
			signalOf([waited(5 * MIN)], "queue-waits", options).occurrences,
		).toBe(0);
		expect(
			signalOf([waited(5 * MIN + 1)], "queue-waits", options).occurrences,
		).toBe(1);
	});

	it("groups by the job's sorted runs-on labels", () => {
		const signal = signalOf(
			[
				waited(2 * MIN, { labels: ["self-hosted", "linux"] }),
				waited(3 * MIN, { labels: ["linux", "self-hosted"] }),
			],
			"queue-waits",
		);
		expect(signal.rows).toEqual([
			{ key: "linux, self-hosted", minutes: 5, occurrences: 2 },
		]);
	});

	it("leaves out relay jobs and jobs no runner took", () => {
		const runs = [
			waited(10 * MIN, { relay: true }),
			run({ jobs: [queued("b")] }),
		];
		expect(signalOf(runs, "queue-waits").occurrences).toBe(0);
	});
});

describe("slowest-job", () => {
	it("counts how long a run went on with only its last job left", () => {
		const signal = signalOf(
			[
				run({
					jobs: [
						ran("lint", 0, 2 * MIN, { id: 1 }),
						ran("unit", 0, 5 * MIN, { id: 2 }),
						ran("e2e", 0, 12 * MIN, { id: 3 }),
					],
				}),
			],
			"slowest-job",
		);
		expect(signal.occurrences).toBe(1);
		expect(signal.rows).toEqual([
			{ key: "CI / e2e", minutes: 7, occurrences: 1 },
		]);
	});

	it("counts only from slowestJobMs", () => {
		const tail = (aloneMs: number): InsightRun =>
			run({
				jobs: [
					ran("unit", 0, 5 * MIN, { id: 1 }),
					ran("e2e", 0, 5 * MIN + aloneMs, { id: 2 }),
				],
			});
		expect(signalOf([tail(MIN - 1)], "slowest-job").occurrences).toBe(0);
		expect(signalOf([tail(MIN)], "slowest-job").occurrences).toBe(1);
		expect(signalOf([tail(MIN + 1)], "slowest-job").occurrences).toBe(1);
		expect(
			signalOf([tail(MIN)], "slowest-job", { slowestJobMs: 2 * MIN })
				.occurrences,
		).toBe(0);
	});

	it("skips a last job that is a later stage", () => {
		const staged = (startMs: number, extra: Partial<InsightJob> = {}) =>
			run({
				jobs: [
					ran("build", 0, 5 * MIN, { id: 1 }),
					ran("deploy", startMs, 15 * MIN, { id: 2, ...extra }),
				],
			});
		expect(signalOf([staged(5 * MIN - 1)], "slowest-job").occurrences).toBe(1);
		expect(signalOf([staged(5 * MIN)], "slowest-job").occurrences).toBe(0);
		expect(signalOf([staged(5 * MIN + 1)], "slowest-job").occurrences).toBe(0);
		expect(
			signalOf([staged(0, { needs: ["build"] })], "slowest-job").occurrences,
		).toBe(0);
		expect(
			signalOf([staged(0, { needs: [] })], "slowest-job").occurrences,
		).toBe(1);
	});

	it("needs two jobs that started and finished", () => {
		const runs = [
			run({ jobs: [] }),
			run({ jobs: [ran("only", 0, 10 * MIN)] }),
			run({
				jobs: [
					ran("only", 0, 10 * MIN),
					queued("waiting"),
					queued("skipped", { conclusion: "skipped", completedAtMs: 0 }),
				],
			}),
		];
		expect(signalOf(runs, "slowest-job").occurrences).toBe(0);
	});

	it("finds no job running alone when two finish together", () => {
		const signal = signalOf(
			[
				run({
					jobs: [
						ran("a", 0, 10 * MIN, { id: 1 }),
						ran("b", 0, 10 * MIN, { id: 2 }),
						ran("c", 0, MIN, { id: 3 }),
					],
				}),
			],
			"slowest-job",
			{ slowestJobMs: 0 },
		);
		expect(signal.occurrences).toBe(0);
	});
});

describe("flaky-jobs", () => {
	const failed = (extra: Partial<InsightJob> = {}): InsightJob =>
		ran("unit", 0, 4 * MIN, { conclusion: "failure", ...extra });
	const passed = ran("unit", 0, 3 * MIN);

	it("counts a job that failed and then passed on the next attempt", () => {
		const signal = signalOf(
			[
				run({ attempt: 1, jobs: [failed()] }),
				run({ attempt: 2, jobs: [passed] }),
			],
			"flaky-jobs",
		);
		expect(signal.rows).toEqual([
			{ key: "CI / unit", minutes: 4, occurrences: 1 },
		]);
	});

	it("counts a job that timed out the first time", () => {
		const runs = [
			run({ attempt: 1, jobs: [failed({ conclusion: "timed_out" })] }),
			run({ attempt: 2, jobs: [passed] }),
		];
		expect(signalOf(runs, "flaky-jobs").occurrences).toBe(1);
	});

	it("counts no minutes for a failed attempt without a finish time", () => {
		const unfinished: InsightJob = {
			...queued("unit", { conclusion: "failure", steps: [SETUP, WORK] }),
			startedAtMs: 0,
		};
		const signal = signalOf(
			[
				run({ attempt: 1, jobs: [unfinished] }),
				run({ attempt: 2, jobs: [passed] }),
			],
			"flaky-jobs",
		);
		expect(signal.occurrences).toBe(1);
		expect(signal.minutes).toBe(0);
	});

	it("looks only at the very next attempt of the same run", () => {
		const first = run({ attempt: 1, jobs: [failed()] });
		expect(signalOf([first], "flaky-jobs").occurrences).toBe(0);
		expect(
			signalOf([first, run({ attempt: 3, jobs: [passed] })], "flaky-jobs")
				.occurrences,
		).toBe(0);
		expect(
			signalOf(
				[first, run({ id: 2, attempt: 2, jobs: [passed] })],
				"flaky-jobs",
			).occurrences,
		).toBe(0);
		expect(
			signalOf(
				[first, run({ repository: "acme/other", attempt: 2, jobs: [passed] })],
				"flaky-jobs",
			).occurrences,
		).toBe(0);
	});

	it("does not count a job that failed again or was not re-run", () => {
		const first = run({ attempt: 1, jobs: [failed()] });
		expect(
			signalOf([first, run({ attempt: 2, jobs: [failed()] })], "flaky-jobs")
				.occurrences,
		).toBe(0);
		expect(
			signalOf(
				[first, run({ attempt: 2, jobs: [ran("other", 0, MIN)] })],
				"flaky-jobs",
			).occurrences,
		).toBe(0);
	});

	it("does not count a name shared by a job that still fails", () => {
		const runs = [
			run({ attempt: 1, jobs: [failed()] }),
			run({ attempt: 2, jobs: [passed, failed({ id: 2 })] }),
		];
		expect(signalOf(runs, "flaky-jobs").occurrences).toBe(0);
	});

	it("does not count a job that never ran a step, or was cancelled", () => {
		const second = run({ attempt: 2, jobs: [passed] });
		expect(
			signalOf(
				[run({ attempt: 1, jobs: [failed({ steps: [SETUP] })] }), second],
				"flaky-jobs",
			).occurrences,
		).toBe(0);
		expect(
			signalOf(
				[
					run({ attempt: 1, jobs: [failed({ conclusion: "cancelled" })] }),
					second,
				],
				"flaky-jobs",
			).occurrences,
		).toBe(0);
	});

	it("uses the first of two entries for the same attempt", () => {
		const runs = [
			run({ attempt: 1, jobs: [failed()] }),
			run({ attempt: 2, jobs: [passed] }),
			run({ attempt: 2, jobs: [failed()] }),
		];
		expect(signalOf(runs, "flaky-jobs").occurrences).toBe(1);
	});
});

describe("runner-failures", () => {
	const broken = (extra: Partial<InsightJob> = {}): InsightJob =>
		ran("unit", 0, 6_000, {
			conclusion: "failure",
			labels: ["self-hosted", "arm64"],
			steps: [{ ...SETUP, conclusion: "failure" }],
			...extra,
		});

	it("counts a failed job a runner started that ran no step", () => {
		const signal = signalOf(
			[run({ jobs: [broken(), broken({ id: 2 })] })],
			"runner-failures",
			{ minRowMinutes: 0 },
		);
		expect(signal.occurrences).toBe(2);
		expect(signal.rows).toEqual([
			{ key: "arm64, self-hosted", minutes: 0.2, occurrences: 2 },
		]);
	});

	it("leaves out jobs that ran steps, did not fail or never started", () => {
		const neverStarted = queued("unit", { conclusion: "failure" });
		const runs = [
			run({
				jobs: [
					broken({ steps: [SETUP, { ...WORK, conclusion: "failure" }] }),
					broken({ conclusion: "cancelled" }),
					broken({ conclusion: "timed_out" }),
					neverStarted,
				],
			}),
		];
		expect(signalOf(runs, "runner-failures").occurrences).toBe(0);
	});
});

describe("no-concurrency", () => {
	const older = (partial: Partial<InsightRun> = {}): InsightRun =>
		run({
			id: 1,
			branch: "feature",
			createdAtMs: 0,
			completedAtMs: 10 * MIN,
			jobs: [ran("unit", 0, 10 * MIN)],
			...partial,
		});
	const newer = (
		createdAtMs: number,
		partial: Partial<InsightRun> = {},
	): InsightRun =>
		run({ id: 2, branch: "feature", createdAtMs, jobs: [], ...partial });

	it("counts the minutes an older run spent after a newer one started", () => {
		const signal = signalOf([older(), newer(4 * MIN)], "no-concurrency");
		expect(signal.rows).toEqual([{ key: "CI", minutes: 6, occurrences: 1 }]);
	});

	it("clips each job to the part after the newer run was created", () => {
		const signal = signalOf(
			[
				older({
					jobs: [
						ran("before", 0, 3 * MIN),
						ran("across", 2 * MIN, 8 * MIN),
						ran("after", 5 * MIN, 10 * MIN),
						queued("never"),
					],
				}),
				newer(4 * MIN),
			],
			"no-concurrency",
		);
		expect(signal.minutes).toBe(9);
	});

	it("needs the newer run to start before the older one completed", () => {
		expect(
			signalOf([older(), newer(10 * MIN - 1)], "no-concurrency").occurrences,
		).toBe(1);
		expect(
			signalOf([older(), newer(10 * MIN)], "no-concurrency").occurrences,
		).toBe(0);
		expect(
			signalOf([older(), newer(10 * MIN + 1)], "no-concurrency").occurrences,
		).toBe(0);
	});

	it("needs the newer run to be created later, not at the same moment", () => {
		expect(signalOf([older(), newer(0)], "no-concurrency").occurrences).toBe(0);
		expect(signalOf([older(), newer(1)], "no-concurrency").occurrences).toBe(1);
	});

	it("cuts off at the earliest newer run", () => {
		const signal = signalOf(
			[older(), newer(7 * MIN, { id: 3 }), newer(2 * MIN), newer(5 * MIN)],
			"no-concurrency",
		);
		expect(signal.minutes).toBe(8);
	});

	it("counts every run that was overtaken", () => {
		const signal = signalOf(
			[
				older(),
				older({
					id: 2,
					createdAtMs: 4 * MIN,
					completedAtMs: 14 * MIN,
					jobs: [ran("unit", 4 * MIN, 14 * MIN)],
				}),
				newer(9 * MIN, { id: 3 }),
			],
			"no-concurrency",
		);
		expect(signal.occurrences).toBe(2);
		expect(signal.minutes).toBe(11);
	});

	it("ignores runs on the default branch", () => {
		const runs = [
			older({ branch: "main" }),
			newer(4 * MIN, { branch: "main" }),
		];
		expect(signalOf(runs, "no-concurrency").occurrences).toBe(0);
	});

	it("ignores an older run that was cancelled, skipped or is still going", () => {
		for (const conclusion of ["cancelled", "skipped"] as const) {
			expect(
				signalOf([older({ conclusion }), newer(4 * MIN)], "no-concurrency")
					.occurrences,
			).toBe(0);
		}
		const running = run({
			branch: "feature",
			jobs: [ran("unit", 0, 10 * MIN)],
		});
		expect(
			signalOf([running, newer(4 * MIN)], "no-concurrency").occurrences,
		).toBe(0);
	});

	it("needs the same repository, workflow file, branch and event", () => {
		const others: readonly Partial<InsightRun>[] = [
			{ repository: "acme/other" },
			{ workflowPath: ".github/workflows/release.yml" },
			{ branch: "feature-2" },
			{ event: "pull_request" },
		];
		for (const other of others) {
			expect(
				signalOf([older(), newer(4 * MIN, other)], "no-concurrency")
					.occurrences,
			).toBe(0);
		}
	});

	it("does not treat a re-run of the same run as a newer run", () => {
		const runs = [older(), newer(4 * MIN, { id: 1, attempt: 2 })];
		expect(signalOf(runs, "no-concurrency").occurrences).toBe(0);
	});
});

describe("same-commit", () => {
	const push = (partial: Partial<InsightRun> = {}): InsightRun =>
		run({
			id: 1,
			event: "push",
			branch: "feature",
			jobs: [ran("unit", 0, 4 * MIN), ran("lint", 0, MIN)],
			...partial,
		});
	const pullRequest = (partial: Partial<InsightRun> = {}): InsightRun =>
		run({
			id: 2,
			event: "pull_request",
			branch: "feature",
			jobs: [ran("unit", 0, 9 * MIN)],
			...partial,
		});

	it("counts the push run when a pull request ran the same commit", () => {
		const signal = signalOf([push(), pullRequest()], "same-commit");
		expect(signal.rows).toEqual([{ key: "CI", minutes: 5, occurrences: 1 }]);
	});

	it("needs the same commit, workflow file and repository", () => {
		const others: readonly Partial<InsightRun>[] = [
			{ headSha: "sha-2" },
			{ workflowPath: ".github/workflows/release.yml" },
			{ repository: "acme/other" },
			{ event: "pull_request_target" },
		];
		for (const other of others) {
			expect(
				signalOf([push(), pullRequest(other)], "same-commit").occurrences,
			).toBe(0);
		}
		expect(signalOf([push()], "same-commit").occurrences).toBe(0);
		expect(signalOf([pullRequest()], "same-commit").occurrences).toBe(0);
	});
});

describe("short-jobs", () => {
	const billed = (runMs: number, extra: Partial<InsightJob> = {}) =>
		run({ jobs: [ran("label", 0, runMs, { billed: true, ...extra })] });

	it("counts the unused part of a billed job's first minute", () => {
		const signal = signalOf([billed(15_000), billed(45_000)], "short-jobs", {
			minRowMinutes: 0,
		});
		expect(signal.rows).toEqual([
			{ key: "CI / label", minutes: 1, occurrences: 2 },
		]);
		expect(signalOf([billed(0)], "short-jobs").minutes).toBe(1);
	});

	it("counts only jobs under shortJobMs", () => {
		const under = signalOf([billed(MIN - 1)], "short-jobs");
		expect(under.occurrences).toBe(1);
		expect(under.minutes).toBeCloseTo(1 / MIN, 10);
		expect(signalOf([billed(MIN)], "short-jobs").occurrences).toBe(0);
		expect(signalOf([billed(MIN + 1)], "short-jobs").occurrences).toBe(0);
	});

	it("never counts negative minutes when the threshold is raised", () => {
		const signal = signalOf([billed(90_000)], "short-jobs", {
			shortJobMs: 2 * MIN,
		});
		expect(signal.occurrences).toBe(1);
		expect(signal.minutes).toBe(0);
	});

	it("leaves out jobs that are not billed or did not finish", () => {
		const runs = [
			billed(10_000, { billed: false }),
			run({ jobs: [queued("label", { billed: true })] }),
		];
		expect(signalOf(runs, "short-jobs").occurrences).toBe(0);
	});
});

describe("isDocsPath", () => {
	it.each([
		"README.md",
		"guide/intro.MDX",
		"notes.markdown",
		"manual/index.rst",
		"book/ch1.adoc",
		"CHANGES.txt",
		"docs/build.ts",
		"packages/ci/doc/diagram.png",
		"Docs/site.css",
		"LICENSE",
		"packages/ci/license",
		"LICENCE",
		"LICENSE-MIT",
		"vendor/COPYING",
		"NOTICE",
		"docs\\windows.md",
	])("takes %s as documentation", (path) => {
		expect(isDocsPath(path)).toBe(true);
	});

	it.each([
		"src/index.ts",
		"src/notice.ts",
		"src/license.go",
		"src/documents/store.ts",
		"docs.ts",
		"readme",
		".md",
		"md",
		"src/txt",
		"",
		"/",
	])("takes %s as not documentation", (path) => {
		expect(isDocsPath(path)).toBe(false);
	});
});

describe("docs-changes", () => {
	const pullRequest = (partial: Partial<InsightRun> = {}): InsightRun =>
		run({
			event: "pull_request",
			branch: "feature",
			jobs: [ran("unit", 0, 8 * MIN)],
			...partial,
		});

	it("counts a pull request run whose changed paths are all documentation", () => {
		const signal = signalOf(
			[pullRequest({ changedPaths: ["README.md", "docs/guide.png"] })],
			"docs-changes",
		);
		expect(signal.rows).toEqual([{ key: "CI", minutes: 8, occurrences: 1 }]);
	});

	it("does not count a change that touches code, or touches nothing", () => {
		expect(
			signalOf(
				[pullRequest({ changedPaths: ["README.md", "src/index.ts"] })],
				"docs-changes",
			).occurrences,
		).toBe(0);
		expect(
			signalOf(
				[pullRequest({ changedPaths: [], title: "docs: tidy" })],
				"docs-changes",
			).occurrences,
		).toBe(0);
	});

	it("lets known paths overrule the title", () => {
		const signal = signalOf(
			[pullRequest({ changedPaths: ["src/index.ts"], title: "docs: tidy" })],
			"docs-changes",
		);
		expect(signal.occurrences).toBe(0);
	});

	it.each([
		"docs: fix a typo",
		"Docs: fix a typo",
		"docs(site): new page",
		"DOCS(api): describe retries",
		"  docs: leading space",
	])("falls back to the title %j when the paths are not known", (title) => {
		expect(signalOf([pullRequest({ title })], "docs-changes").occurrences).toBe(
			1,
		);
	});

	it.each([
		"docs fix a typo",
		"feat: docs for retries",
		"docs(site: new page",
		"docs(a)(b): new page",
		"docsite: new page",
	])("does not take the title %j for a documentation change", (title) => {
		expect(signalOf([pullRequest({ title })], "docs-changes").occurrences).toBe(
			0,
		);
	});

	it("does not count a run with neither paths nor a title", () => {
		expect(signalOf([pullRequest()], "docs-changes").occurrences).toBe(0);
	});

	it("leaves out workflows that are about documentation", () => {
		for (const workflow of ["Docs", "Build documentation", "doc-links"]) {
			expect(
				signalOf(
					[pullRequest({ workflow, changedPaths: ["README.md"] })],
					"docs-changes",
				).occurrences,
			).toBe(0);
		}
	});

	it("leaves out runs that are not for a pull request", () => {
		expect(
			signalOf(
				[pullRequest({ event: "push", changedPaths: ["README.md"] })],
				"docs-changes",
			).occurrences,
		).toBe(0);
	});
});

describe("wide-fanout", () => {
	const fanout = (
		started: number,
		partial: Partial<InsightRun> = {},
		extraJobs: readonly InsightJob[] = [],
	): InsightRun =>
		run({
			event: "pull_request",
			branch: "feature",
			jobs: [
				...Array.from({ length: started }, (_, index) =>
					ran(`shard ${index}`, 0, MIN, { id: index }),
				),
				...extraJobs,
			],
			...partial,
		});

	it("counts a run that started at least fanoutJobs jobs", () => {
		expect(signalOf([fanout(9)], "wide-fanout").occurrences).toBe(0);
		const exact = signalOf([fanout(10)], "wide-fanout");
		expect(exact.rows).toEqual([{ key: "CI", minutes: 10, occurrences: 1 }]);
		expect(signalOf([fanout(11)], "wide-fanout").occurrences).toBe(1);
	});

	it("honours a different threshold", () => {
		expect(
			signalOf([fanout(2)], "wide-fanout", { fanoutJobs: 3 }).occurrences,
		).toBe(0);
		expect(
			signalOf([fanout(3)], "wide-fanout", { fanoutJobs: 3 }).occurrences,
		).toBe(1);
	});

	it("does not count relay jobs or jobs no runner took", () => {
		const signal = signalOf(
			[
				fanout(9, {}, [
					ran("route", 0, MIN, { relay: true }),
					queued("pending"),
				]),
			],
			"wide-fanout",
		);
		expect(signal.occurrences).toBe(0);
	});

	it("counts push runs too, but only off the default branch", () => {
		expect(
			signalOf([fanout(10, { event: "push" })], "wide-fanout").occurrences,
		).toBe(1);
		expect(
			signalOf([fanout(10, { branch: "main" })], "wide-fanout").occurrences,
		).toBe(0);
		expect(
			signalOf([fanout(10, { event: "schedule" })], "wide-fanout").occurrences,
		).toBe(0);
	});
});
