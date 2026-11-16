import { describe, expect, it } from "vitest";
import { compareText, compareTextIgnoringCase } from "../src/insights/order.js";
import {
	type InsightJob,
	type InsightRun,
	type InsightStep,
	jobBilledMinutes,
	jobKey,
	jobRunMinutes,
	jobRunMs,
	jobWaitMs,
	MS_PER_MINUTE,
	NO_LABELS_KEY,
	ranSteps,
	runJobMinutes,
	runnerKey,
	SETUP_STEP_NAME,
} from "../src/insights/types.js";

function step(partial: Partial<InsightStep> = {}): InsightStep {
	return {
		name: "Run pnpm test",
		number: 2,
		conclusion: "success",
		...partial,
	};
}

function job(partial: Partial<InsightJob> = {}): InsightJob {
	return {
		id: 1,
		name: "test",
		labels: ["ubuntu-latest"],
		conclusion: "success",
		queuedAtMs: 0,
		steps: [],
		billed: false,
		...partial,
	};
}

function run(jobs: readonly InsightJob[]): InsightRun {
	return {
		id: 1,
		attempt: 1,
		repository: "acme/app",
		workflow: "CI",
		workflowPath: ".github/workflows/ci.yml",
		event: "push",
		branch: "main",
		defaultBranch: "main",
		headSha: "abc",
		actor: "sam",
		conclusion: "success",
		createdAtMs: 0,
		jobs,
	};
}

describe("jobWaitMs", () => {
	it("is the time from queued to started", () => {
		expect(jobWaitMs(job({ queuedAtMs: 1_000, startedAtMs: 4_500 }))).toBe(
			3_500,
		);
	});

	it("is undefined when no runner took the job", () => {
		expect(jobWaitMs(job({ queuedAtMs: 1_000 }))).toBeUndefined();
	});

	it("is never negative when the timestamps are out of order", () => {
		expect(jobWaitMs(job({ queuedAtMs: 5_000, startedAtMs: 4_000 }))).toBe(0);
	});
});

describe("jobRunMs and jobRunMinutes", () => {
	it("is the time from started to completed", () => {
		const finished = job({ startedAtMs: 10_000, completedAtMs: 100_000 });
		expect(jobRunMs(finished)).toBe(90_000);
		expect(jobRunMinutes(finished)).toBe(1.5);
	});

	it("is undefined, and no minutes, for a job that never started", () => {
		const unstarted = job({ completedAtMs: 100_000 });
		expect(jobRunMs(unstarted)).toBeUndefined();
		expect(jobRunMinutes(unstarted)).toBe(0);
	});

	it("is undefined, and no minutes, for a job still running", () => {
		const running = job({ startedAtMs: 10_000 });
		expect(jobRunMs(running)).toBeUndefined();
		expect(jobRunMinutes(running)).toBe(0);
	});

	it("is never negative", () => {
		expect(jobRunMs(job({ startedAtMs: 10_000, completedAtMs: 9_000 }))).toBe(
			0,
		);
	});
});

describe("jobBilledMinutes", () => {
	const ranFor = (runMs: number): InsightJob =>
		job({ startedAtMs: 0, completedAtMs: runMs });

	it("bills at least one minute for a job that ran at all", () => {
		expect(jobBilledMinutes(ranFor(0))).toBe(1);
		expect(jobBilledMinutes(ranFor(1))).toBe(1);
	});

	it("rounds a part minute up to the next whole one", () => {
		expect(jobBilledMinutes(ranFor(MS_PER_MINUTE - 1))).toBe(1);
		expect(jobBilledMinutes(ranFor(MS_PER_MINUTE))).toBe(1);
		expect(jobBilledMinutes(ranFor(MS_PER_MINUTE + 1))).toBe(2);
		expect(jobBilledMinutes(ranFor(2 * MS_PER_MINUTE))).toBe(2);
	});

	it("bills nothing for a job that did not start or has not finished", () => {
		expect(jobBilledMinutes(job({ completedAtMs: 5_000 }))).toBe(0);
		expect(jobBilledMinutes(job({ startedAtMs: 5_000 }))).toBe(0);
	});
});

describe("ranSteps", () => {
	const setup = step({ name: SETUP_STEP_NAME, number: 1 });

	it("is false for a job with no steps", () => {
		expect(ranSteps(job())).toBe(false);
	});

	it("is false when only GitHub's set-up step ran", () => {
		expect(ranSteps(job({ steps: [setup] }))).toBe(false);
		expect(
			ranSteps(job({ steps: [{ ...setup, conclusion: "failure" }] })),
		).toBe(false);
	});

	it("is false when every other step was skipped", () => {
		expect(
			ranSteps(job({ steps: [setup, step({ conclusion: "skipped" })] })),
		).toBe(false);
	});

	it("is true once another step has any other conclusion", () => {
		for (const conclusion of [
			"success",
			"failure",
			"cancelled",
			"timed_out",
			"unknown",
		] as const) {
			expect(ranSteps(job({ steps: [setup, step({ conclusion })] }))).toBe(
				true,
			);
		}
	});
});

describe("runnerKey", () => {
	it("joins the labels in an order that ignores case", () => {
		expect(runnerKey(["self-hosted", "Linux", "arm64"])).toBe(
			"arm64, Linux, self-hosted",
		);
	});

	it("gives the same key whatever order the labels were written in", () => {
		expect(runnerKey(["linux", "self-hosted"])).toBe(
			runnerKey(["self-hosted", "linux"]),
		);
	});

	it("trims labels and drops empty ones", () => {
		expect(runnerKey([" ubuntu-latest ", "", "  "])).toBe("ubuntu-latest");
	});

	it("names a job with no labels", () => {
		expect(runnerKey([])).toBe(NO_LABELS_KEY);
		expect(runnerKey([" "])).toBe(NO_LABELS_KEY);
	});
});

describe("jobKey and runJobMinutes", () => {
	it("names a job by its workflow and its own name", () => {
		expect(jobKey("CI", "test (20)")).toBe("CI / test (20)");
	});

	it("adds up the run time of the jobs that started and finished", () => {
		const jobs = [
			job({ startedAtMs: 0, completedAtMs: 90_000 }),
			job({ startedAtMs: 30_000, completedAtMs: 60_000 }),
			job({ startedAtMs: 30_000 }),
			job({ completedAtMs: 60_000 }),
		];
		expect(runJobMinutes(run(jobs))).toBe(2);
		expect(runJobMinutes(run([]))).toBe(0);
	});
});

describe("text order", () => {
	it("orders by code unit", () => {
		expect(compareText("a", "b")).toBeLessThan(0);
		expect(compareText("b", "a")).toBeGreaterThan(0);
		expect(compareText("a", "a")).toBe(0);
		expect(compareText("B", "a")).toBeLessThan(0);
	});

	it("can ignore case, and still orders texts that differ only in case", () => {
		expect(compareTextIgnoringCase("B", "a")).toBeGreaterThan(0);
		expect(compareTextIgnoringCase("a", "B")).toBeLessThan(0);
		expect(compareTextIgnoringCase("A", "a")).toBeLessThan(0);
		expect(compareTextIgnoringCase("a", "A")).toBeGreaterThan(0);
		expect(compareTextIgnoringCase("a", "a")).toBe(0);
	});
});
