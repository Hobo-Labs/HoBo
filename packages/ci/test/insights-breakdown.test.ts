import { describe, expect, it } from "vitest";
import {
	SIGNAL_DIMENSIONS,
	type SignalSlice,
	signalBreakdown,
} from "../src/insights/breakdown.js";
import { CI_SIGNAL_IDS, ciSignals } from "../src/insights/signals.js";
import type { InsightJob, InsightRun } from "../src/insights/types.js";

const MIN = 60_000;
const DAY = 86_400_000;
/** 2026-11-02T00:00:00Z */
const DAY_ONE = Date.UTC(2026, 10, 2);
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function job(
	id: number,
	name: string,
	startAtMs: number,
	runMs: number,
	extra: Partial<InsightJob> = {},
): InsightJob {
	return {
		id,
		name,
		labels: ["ubuntu-24.04"],
		conclusion: "success",
		queuedAtMs: startAtMs - 1_000,
		startedAtMs: startAtMs,
		completedAtMs: startAtMs + runMs,
		steps: [
			{ name: "Set up job", number: 1, conclusion: "success" },
			{ name: "Run", number: 2, conclusion: "success" },
		],
		billed: true,
		...extra,
	};
}

function run(
	id: number,
	fields: Partial<InsightRun> & Pick<InsightRun, "jobs" | "createdAtMs">,
): InsightRun {
	return {
		id,
		attempt: 1,
		repository: "octo/app",
		workflow: "CI",
		workflowPath: ".github/workflows/ci.yml",
		event: "push",
		branch: "feature",
		defaultBranch: "main",
		headSha: SHA_A,
		actor: "alice",
		conclusion: "success",
		completedAtMs: fields.createdAtMs + 10 * MIN,
		...fields,
	};
}

const t = DAY_ONE + 1_000;
const RUNS: readonly InsightRun[] = [
	// alice's push of SHA_A: also run for a pull request, so `same-commit`.
	run(1, {
		createdAtMs: t,
		actor: "alice",
		jobs: [job(11, "build", t, 5 * MIN)],
	}),
	run(2, {
		createdAtMs: t + 500,
		event: "pull_request",
		actor: "alice",
		jobs: [job(21, "build", t + 500, 5 * MIN)],
	}),
	// bob's short job, a queue wait over a minute, and a runner failure, next day.
	run(3, {
		createdAtMs: t + DAY,
		actor: "bob",
		headSha: SHA_B,
		branch: "main",
		repository: "octo/lib",
		workflow: "Lint",
		workflowPath: ".github/workflows/lint.yml",
		jobs: [
			job(31, "lint", t + DAY, 10_000),
			{
				...job(32, "slow-queue", t + DAY + 5 * MIN, 2 * MIN),
				queuedAtMs: t + DAY,
			},
			{
				...job(33, "broke", t + DAY, 3_000),
				conclusion: "failure",
				steps: [{ name: "Set up job", number: 1, conclusion: "failure" }],
			},
		],
	}),
	// carol's flaky job: fails on attempt 1, passes on attempt 2.
	run(4, {
		createdAtMs: t + DAY,
		actor: "carol",
		headSha: SHA_B,
		event: "schedule",
		conclusion: "failure",
		jobs: [job(41, "e2e", t + DAY, 4 * MIN, { conclusion: "failure" })],
	}),
	{
		...run(4, {
			createdAtMs: t + DAY + 20 * MIN,
			actor: "carol",
			headSha: SHA_B,
			event: "schedule",
			jobs: [job(42, "e2e", t + DAY + 20 * MIN, 4 * MIN)],
		}),
		attempt: 2,
	},
];

function slice(
	slices: readonly SignalSlice[],
	key: string,
): SignalSlice | undefined {
	return slices.find((entry) => entry.key === key);
}

function signalOf(entry: SignalSlice | undefined, id: string) {
	return entry?.signals.find((signal) => signal.id === id);
}

describe("signalBreakdown", () => {
	const breakdown = signalBreakdown(RUNS);

	it("leaves what ciSignals returns unchanged", () => {
		expect(breakdown.signals).toEqual(ciSignals(RUNS));
		expect(
			signalBreakdown(RUNS, { minMinutes: 0, maxRows: 1 }).signals,
		).toEqual(ciSignals(RUNS, { minMinutes: 0, maxRows: 1 }));
	});

	it("breaks every signal down by each dimension without losing a minute", () => {
		expect(SIGNAL_DIMENSIONS).toEqual([
			"person",
			"repository",
			"workflow",
			"branch",
			"event",
		]);
		for (const dimension of SIGNAL_DIMENSIONS) {
			for (const signal of breakdown.signals.signals) {
				const parts = breakdown.by[dimension].map((entry) =>
					signalOf(entry, signal.id),
				);
				const minutes = parts.reduce(
					(total, part) => total + (part?.minutes ?? 0),
					0,
				);
				const occurrences = parts.reduce(
					(total, part) => total + (part?.occurrences ?? 0),
					0,
				);
				expect(minutes).toBeCloseTo(signal.minutes);
				expect(occurrences).toBe(signal.occurrences);
			}
		}
	});

	it("names whose runs a signal came from", () => {
		const people = breakdown.by.person;
		expect(signalOf(slice(people, "alice"), "same-commit")).toEqual({
			id: "same-commit",
			minutes: 5,
			occurrences: 1,
		});
		expect(signalOf(slice(people, "bob"), "short-jobs")?.occurrences).toBe(2);
		expect(signalOf(slice(people, "bob"), "queue-waits")?.minutes).toBe(5);
		expect(signalOf(slice(people, "bob"), "runner-failures")?.occurrences).toBe(
			1,
		);
		expect(signalOf(slice(people, "carol"), "flaky-jobs")).toEqual({
			id: "flaky-jobs",
			minutes: 4,
			occurrences: 1,
		});
		expect(signalOf(slice(people, "carol"), "same-commit")?.occurrences).toBe(
			0,
		);
	});

	it("lists every signal in report order for each slice", () => {
		for (const entry of breakdown.by.event) {
			expect(entry.signals.map((signal) => signal.id)).toEqual([
				...CI_SIGNAL_IDS,
			]);
		}
	});

	it("groups by repository, workflow, branch and event", () => {
		expect(breakdown.by.repository.map((entry) => entry.key).sort()).toEqual([
			"octo/app",
			"octo/lib",
		]);
		expect(slice(breakdown.by.workflow, "Lint")?.runs).toBe(1);
		expect(slice(breakdown.by.branch, "main")?.runs).toBe(1);
		expect(slice(breakdown.by.event, "schedule")?.runs).toBe(2);
		expect(slice(breakdown.by.event, "push")?.jobMinutes).toBeCloseTo(
			5 + (10_000 + 2 * MIN + 3_000) / MIN,
		);
	});

	it("puts the slice with the most signal minutes first", () => {
		const minutes = breakdown.by.person.map((entry) => entry.minutes);
		expect([...minutes].sort((left, right) => right - left)).toEqual(minutes);
	});

	it("trends the signals per UTC day of each run's start", () => {
		expect(breakdown.trend.map((day) => [day.day, day.runs])).toEqual([
			["2026-11-02", 2],
			["2026-11-03", 3],
		]);
		const [first, second] = breakdown.trend;
		expect(signalOf(first, "same-commit")?.occurrences).toBe(1);
		expect(signalOf(first, "flaky-jobs")?.occurrences).toBe(0);
		expect(signalOf(second, "flaky-jobs")?.occurrences).toBe(1);
		expect(first?.jobMinutes).toBeCloseTo(10);
	});

	it("is empty for no runs", () => {
		const empty = signalBreakdown([]);
		expect(empty.trend).toEqual([]);
		expect(empty.by.person).toEqual([]);
		expect(empty.signals).toEqual(ciSignals([]));
	});

	it("keeps workflow names with documentation in them out of docs-changes", () => {
		const docsRun = run(9, {
			createdAtMs: t,
			event: "pull_request",
			workflow: "Docs",
			changedPaths: ["README.md"],
			jobs: [job(91, "build", t, 2 * MIN)],
		});
		const result = signalBreakdown([docsRun], { minMinutes: 0 });
		expect(result.signals).toEqual(ciSignals([docsRun], { minMinutes: 0 }));
		expect(
			signalOf(slice(result.by.workflow, "Docs"), "docs-changes")?.occurrences,
		).toBe(0);
	});
});
