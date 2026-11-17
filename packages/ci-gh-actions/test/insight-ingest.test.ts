import type { InsightRun } from "@hobo/ci/insights";
import { signalBreakdown } from "@hobo/ci/insights/breakdown";
import { SqliteInsightStore } from "@hobo/ci/insights/history-sqlite";
import { usageReport } from "@hobo/ci/insights/usage";
import {
	InMemoryInsightStore,
	insightStoreConformance,
} from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import {
	foldInsightWebhook,
	type InsightAttemptStore,
	InsightIngest,
	parseInsightWebhook,
	UNKNOWN_EVENT,
} from "../src/insight-ingest.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const T0 = Date.parse("2026-11-10T09:00:00Z");
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

/** The in-memory fake, with the one keyed read ingest needs. */
class FakeHistory extends InMemoryInsightStore implements InsightAttemptStore {
	async attempt(
		repository: string,
		id: number,
		attempt: number,
	): Promise<InsightRun | undefined> {
		const all = await this.runs({
			repository,
			sinceMs: 0,
			limit: Number.MAX_SAFE_INTEGER,
		});
		return all.find((run) => run.id === id && run.attempt === attempt);
	}
}

const repository = (isPrivate: boolean) => ({
	full_name: "octo/app",
	private: isPrivate,
	default_branch: "main",
});

type JobOptions = Readonly<{
	action: "queued" | "waiting" | "in_progress" | "completed";
	id?: number;
	runId?: number;
	attempt?: number;
	name?: string;
	labels?: readonly string[];
	runner?: string | null;
	conclusion?: string | null;
	startMs?: number;
	endMs?: number;
	steps?: readonly Readonly<{
		name: string;
		number: number;
		conclusion: string | null;
		started_at: string | null;
		completed_at: string | null;
	}>[];
	isPrivate?: boolean;
}>;

function jobBody(options: JobOptions): string {
	return JSON.stringify({
		action: options.action,
		workflow_job: {
			id: options.id ?? 501,
			run_id: options.runId ?? 9001,
			run_attempt: options.attempt ?? 1,
			name: options.name ?? "test",
			workflow_name: "CI",
			head_branch: "feature",
			head_sha: SHA,
			status: options.action === "completed" ? "completed" : options.action,
			conclusion: options.conclusion ?? null,
			labels: options.labels ?? ["ubuntu-latest"],
			runner_name: options.runner ?? null,
			// GitHub's own runners report the "GitHub Actions" group; self-hosted ones their own.
			runner_group_name: options.runner
				? (options.labels ?? []).includes("self-hosted")
					? "Default"
					: "GitHub Actions"
				: null,
			created_at: iso(0),
			started_at: options.startMs === undefined ? iso(0) : iso(options.startMs),
			completed_at: options.endMs === undefined ? null : iso(options.endMs),
			steps: options.steps ?? [],
		},
		repository: repository(options.isPrivate ?? true),
		sender: { login: "octocat" },
	});
}

type RunOptions = Readonly<{
	action: "requested" | "in_progress" | "completed";
	id?: number;
	attempt?: number;
	conclusion?: string | null;
	endMs?: number;
	event?: string;
	actor?: string;
	branch?: string;
	name?: string;
	createdMs?: number;
}>;

function runBody(options: RunOptions): string {
	const createdMs = options.createdMs ?? 0;
	return JSON.stringify({
		action: options.action,
		workflow_run: {
			id: options.id ?? 9001,
			run_attempt: options.attempt ?? 1,
			name: options.name ?? "CI",
			path: ".github/workflows/ci.yml",
			event: options.event ?? "pull_request",
			head_branch: options.branch ?? "feature",
			head_sha: SHA,
			status: options.action === "completed" ? "completed" : options.action,
			conclusion: options.conclusion ?? null,
			created_at: iso(createdMs),
			run_started_at: iso(createdMs),
			updated_at: iso(options.endMs ?? createdMs),
			display_title: "fix: a thing",
			actor: { login: options.actor ?? "octocat" },
		},
		repository: repository(true),
		sender: { login: options.actor ?? "octocat" },
	});
}

const step = (
	name: string,
	number: number,
	conclusion: string | null,
	fromMs: number,
	toMs: number | undefined,
) => ({
	name,
	number,
	conclusion,
	started_at: iso(fromMs),
	completed_at: toMs === undefined ? null : iso(toMs),
});

describe("parseInsightWebhook", () => {
	it("leaves other events alone", () => {
		expect(parseInsightWebhook("push", "{}")).toBeUndefined();
		expect(parseInsightWebhook("check_run", "{}")).toBeUndefined();
	});

	it("refuses a workflow_job payload GitHub would not send", () => {
		expect(() =>
			parseInsightWebhook("workflow_job", JSON.stringify({ action: "queued" })),
		).toThrow();
		expect(() => parseInsightWebhook("workflow_job", "not json")).toThrow();
	});

	it("reads a completed job with its steps, runner and billing", () => {
		const fact = parseInsightWebhook(
			"workflow_job",
			jobBody({
				action: "completed",
				runner: "GitHub Actions 7",
				conclusion: "success",
				startMs: 4_000,
				endMs: 34_000,
				steps: [
					step("Set up job", 1, "success", 4_000, 5_000),
					step("Run tests", 2, "success", 5_000, 33_000),
				],
			}),
		);
		expect(fact?.kind).toBe("job");
		if (fact?.kind !== "job") return;
		expect(fact.repository).toBe("octo/app");
		expect(fact.runId).toBe(9001);
		expect(fact.attempt).toBe(1);
		expect(fact.job).toEqual({
			id: 501,
			name: "test",
			labels: ["ubuntu-latest"],
			runnerName: "GitHub Actions 7",
			runnerGroup: "GitHub Actions",
			conclusion: "success",
			queuedAtMs: T0,
			startedAtMs: T0 + 4_000,
			completedAtMs: T0 + 34_000,
			steps: [
				{
					name: "Set up job",
					number: 1,
					conclusion: "success",
					startedAtMs: T0 + 4_000,
					completedAtMs: T0 + 5_000,
				},
				{
					name: "Run tests",
					number: 2,
					conclusion: "success",
					startedAtMs: T0 + 5_000,
					completedAtMs: T0 + 33_000,
				},
			],
			billed: true,
		});
	});

	it("does not count a start GitHub stamps on a job no runner took", () => {
		const fact = parseInsightWebhook(
			"workflow_job",
			jobBody({ action: "queued", startMs: 0 }),
		);
		if (fact?.kind !== "job") throw new Error("expected a job");
		expect(fact.job.startedAtMs).toBeUndefined();
		expect(fact.job.conclusion).toBe("unknown");
	});

	it("bills only GitHub-hosted jobs in private repositories, and marks relay jobs", () => {
		const of = (options: JobOptions) => {
			const fact = parseInsightWebhook("workflow_job", jobBody(options));
			if (fact?.kind !== "job") throw new Error("expected a job");
			return fact.job;
		};
		expect(of({ action: "queued", isPrivate: false }).billed).toBe(false);
		expect(
			of({ action: "queued", labels: ["self-hosted", "linux"] }).billed,
		).toBe(false);
		expect(of({ action: "queued", labels: ["hobo-relay"] }).relay).toBe(true);
		expect(of({ action: "queued", name: "route (linux)" }).relay).toBe(true);
		expect(
			of({ action: "queued", name: "router-tests" }).relay,
		).toBeUndefined();
	});

	it("reads a startup failure as a failure and an unknown conclusion as unknown", () => {
		const run = (conclusion: string) => {
			const fact = parseInsightWebhook(
				"workflow_run",
				runBody({ action: "completed", conclusion, endMs: 1_000 }),
			);
			if (fact?.kind !== "run") throw new Error("expected a run");
			return fact.run.conclusion;
		};
		expect(run("startup_failure")).toBe("failure");
		expect(run("action_required")).toBe("unknown");
		expect(run("timed_out")).toBe("timed_out");
	});
});

describe("foldInsightWebhook", () => {
	const job = (options: JobOptions) => {
		const fact = parseInsightWebhook("workflow_job", jobBody(options));
		if (fact?.kind !== "job") throw new Error("expected a job");
		return fact;
	};
	const run = (options: RunOptions) => {
		const fact = parseInsightWebhook("workflow_run", runBody(options));
		if (fact?.kind !== "run") throw new Error("expected a run");
		return fact;
	};

	it("starts a run from a job that arrives first, and the run fills it in later", () => {
		const seeded = foldInsightWebhook(undefined, job({ action: "queued" }));
		expect(seeded.event).toBe(UNKNOWN_EVENT);
		expect(seeded.workflow).toBe("CI");
		expect(seeded.branch).toBe("feature");
		expect(seeded.actor).toBe("octocat");
		expect(seeded.jobs).toHaveLength(1);
		const filled = foldInsightWebhook(
			seeded,
			run({ action: "requested", event: "push", actor: "hubot" }),
		);
		expect(filled.event).toBe("push");
		expect(filled.actor).toBe("hubot");
		expect(filled.workflowPath).toBe(".github/workflows/ci.yml");
		expect(filled.jobs).toEqual(seeded.jobs);
		expect(Object.isFrozen(filled)).toBe(true);
	});

	it("keeps a finished job when an older webhook for it arrives late", () => {
		const done = foldInsightWebhook(
			undefined,
			job({
				action: "completed",
				runner: "r1",
				conclusion: "success",
				startMs: 1_000,
				endMs: 9_000,
			}),
		);
		const late = foldInsightWebhook(
			done,
			job({ action: "in_progress", runner: "r1", startMs: 1_000 }),
		);
		expect(late.jobs).toEqual(done.jobs);
	});

	it("keeps a finished run when its requested webhook arrives late", () => {
		const done = foldInsightWebhook(
			undefined,
			run({ action: "completed", conclusion: "cancelled", endMs: 60_000 }),
		);
		const late = foldInsightWebhook(done, run({ action: "requested" }));
		expect(late.conclusion).toBe("cancelled");
		expect(late.completedAtMs).toBe(T0 + 60_000);
	});

	it("orders jobs by when they were queued, then by id", () => {
		const one = foldInsightWebhook(undefined, job({ action: "queued", id: 9 }));
		const two = foldInsightWebhook(one, job({ action: "queued", id: 3 }));
		expect(two.jobs.map((entry) => entry.id)).toEqual([3, 9]);
	});

	it("refuses a job for another run", () => {
		const first = foldInsightWebhook(undefined, job({ action: "queued" }));
		expect(() =>
			foldInsightWebhook(first, job({ action: "queued", runId: 1 })),
		).toThrow(/another run/);
	});
});

/** Webhooks of two runs on one day: a failed run with a time-out, then a re-run superseded and cancelled. */
async function deliverHistory(ingest: InsightIngest): Promise<void> {
	const deliveries: ReadonlyArray<readonly [string, string]> = [
		["workflow_run", runBody({ action: "requested" })],
		["workflow_job", jobBody({ action: "queued", id: 1, name: "lint" })],
		["workflow_job", jobBody({ action: "queued", id: 2, name: "test" })],
		[
			"workflow_job",
			jobBody({
				action: "completed",
				id: 1,
				name: "lint",
				runner: "GitHub Actions 1",
				conclusion: "success",
				startMs: 2_000,
				endMs: 22_000,
				steps: [
					step("Set up job", 1, "success", 2_000, 3_000),
					step("Lint", 2, "success", 3_000, 21_000),
				],
			}),
		],
		[
			"workflow_job",
			jobBody({
				action: "completed",
				id: 2,
				name: "test",
				labels: ["self-hosted", "linux"],
				runner: "box-1",
				conclusion: "timed_out",
				startMs: 5_000,
				endMs: 365_000,
				steps: [
					step("Set up job", 1, "success", 5_000, 6_000),
					step("Run tests", 2, "cancelled", 6_000, 365_000),
				],
			}),
		],
		[
			"workflow_run",
			runBody({ action: "completed", conclusion: "failure", endMs: 366_000 }),
		],
		[
			"workflow_run",
			runBody({ action: "requested", attempt: 2, createdMs: 400_000 }),
		],
		[
			"workflow_job",
			jobBody({
				action: "completed",
				id: 3,
				attempt: 2,
				name: "test",
				labels: ["self-hosted", "linux"],
				runner: "box-1",
				conclusion: "cancelled",
				startMs: 401_000,
				endMs: 431_000,
				steps: [step("Set up job", 1, "success", 401_000, 402_000)],
			}),
		],
		[
			"workflow_run",
			runBody({
				action: "completed",
				attempt: 2,
				conclusion: "cancelled",
				createdMs: 400_000,
				endMs: 432_000,
			}),
		],
		["push", "{}"],
	];
	for (const [event, body] of deliveries) await ingest.deliver(event, body);
}

const RATE = {
	usdPerMinute: 0.008,
	source:
		"https://docs.github.com/en/billing/reference/actions-minute-multipliers",
	readOn: "2026-11-17",
};

const stores: ReadonlyArray<readonly [string, () => InsightAttemptStore]> = [
	["the in-memory fake", () => new FakeHistory()],
	["SqliteInsightStore", () => SqliteInsightStore.open(":memory:")],
];

describe.each(stores)("history from webhooks, kept in %s", (_name, make) => {
	it("the store keeps the insight store's rules", () =>
		insightStoreConformance(make));

	it("I02: runs and jobs come back with step timings, time-outs and superseded runs", async () => {
		const store = make();
		await deliverHistory(new InsightIngest(store));
		const runs = await store.runs({
			repository: "octo/app",
			sinceMs: 0,
			limit: 10,
		});
		expect(runs.map((run) => [run.attempt, run.conclusion])).toEqual([
			[2, "cancelled"],
			[1, "failure"],
		]);
		const [rerun, first] = runs;
		expect(first?.event).toBe("pull_request");
		expect(first?.completedAtMs).toBe(T0 + 366_000);
		expect(first?.jobs.map((job) => [job.name, job.conclusion])).toEqual([
			["lint", "success"],
			["test", "timed_out"],
		]);
		expect(first?.jobs[1]?.steps[1]).toEqual({
			name: "Run tests",
			number: 2,
			conclusion: "cancelled",
			startedAtMs: T0 + 6_000,
			completedAtMs: T0 + 365_000,
		});
		expect(rerun?.createdAtMs).toBe(T0 + 400_000);
		expect(rerun?.jobs.map((job) => job.id)).toEqual([3]);
	});

	it("I03: usage counts billed minutes per runner, short-job waste and minutes kept off GitHub", async () => {
		const store = make();
		await deliverHistory(new InsightIngest(store));
		const report = usageReport(
			await store.runs({ repository: "octo/app", sinceMs: 0, limit: 10 }),
			{ githubRate: RATE, included: undefined, publicRepositories: new Set() },
		);
		expect(report.billedMinutes).toBe(1);
		expect(report.shortJobs).toBe(1);
		expect(report.wasteMinutes).toBeCloseTo(40 / 60);
		// 6 minutes timed out plus 30 seconds cancelled, each rounded up the way GitHub bills.
		expect(report.keptMinutes).toBe(7);
		expect(report.keptUsd).toBeCloseTo(7 * 0.008);
		expect(report.runners.map((row) => [row.runner, row.hosted])).toEqual([
			["linux, self-hosted", false],
			["ubuntu-latest", true],
		]);
		expect(report.days.map((day) => day.day)).toEqual(["2026-11-10"]);
	});

	it("I05: the nine signals break down by person, repository, workflow, branch and event, per day", async () => {
		const store = make();
		await deliverHistory(new InsightIngest(store));
		const runs = await store.runs({
			repository: "octo/app",
			sinceMs: 0,
			limit: 10,
		});
		const breakdown = signalBreakdown(runs);
		expect(breakdown.by.person.map((slice) => slice.key)).toEqual(["octocat"]);
		expect(breakdown.by.event.map((slice) => slice.key)).toEqual([
			"pull_request",
		]);
		expect(breakdown.by.branch.map((slice) => slice.runs)).toEqual([2]);
		expect(breakdown.trend.map((day) => day.day)).toEqual(["2026-11-10"]);
		for (const signal of breakdown.signals.signals) {
			const sliced = breakdown.by.workflow
				.flatMap((slice) => slice.signals)
				.filter((count) => count.id === signal.id)
				.reduce((sum, count) => sum + count.minutes, 0);
			expect(sliced).toBeCloseTo(signal.minutes);
		}
	});
});

describe("InsightIngest", () => {
	it("applies webhooks for one run in the order they were delivered", async () => {
		const store = new FakeHistory();
		const ingest = new InsightIngest(store);
		await Promise.all([
			ingest.deliver("workflow_job", jobBody({ action: "queued", id: 1 })),
			ingest.deliver("workflow_job", jobBody({ action: "queued", id: 2 })),
			ingest.deliver("workflow_job", jobBody({ action: "queued", id: 3 })),
		]);
		const kept = await store.attempt("octo/app", 9001, 1);
		expect(kept?.jobs.map((job) => job.id)).toEqual([1, 2, 3]);
	});

	it("answers with the run it stored, or nothing for an event it does not read", async () => {
		const ingest = new InsightIngest(new FakeHistory());
		expect(await ingest.deliver("push", "{}")).toBeUndefined();
		const run = await ingest.deliver(
			"workflow_run",
			runBody({ action: "requested" }),
		);
		expect(run?.id).toBe(9001);
	});
});
