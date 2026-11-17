/**
 * Run history for the `hobo ci usage` and `performance` tests: two weeks of
 * runs on GitHub's `ubuntu-latest` and on a Depot runner, with short jobs,
 * queue waits and one flaky job, and a fake `gh` that serves the same runs
 * the way GitHub's REST API lists them.
 */
import type { InsightJob, InsightRun } from "@hobo/ci/insights";
import type { CiRunExec } from "../../src/ci-runs.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
export const HISTORY_REPOSITORY = "octo/app";

function job(
	init: Readonly<{
		id: number;
		name: string;
		label: string;
		queuedAtMs: number;
		waitMs: number;
		runMs: number;
		conclusion?: "success" | "failure";
	}>,
): InsightJob {
	const startedAtMs = init.queuedAtMs + init.waitMs;
	const hosted = init.label === "ubuntu-latest";
	return {
		id: init.id,
		name: init.name,
		labels: [init.label],
		runnerName: hosted ? "GitHub Actions 7" : "depot-runner-1",
		runnerGroup: hosted ? "GitHub Actions" : "Default",
		conclusion: init.conclusion ?? "success",
		queuedAtMs: init.queuedAtMs,
		startedAtMs,
		completedAtMs: startedAtMs + init.runMs,
		steps: [
			{
				name: "Set up job",
				number: 1,
				conclusion: "success",
				startedAtMs,
				completedAtMs: startedAtMs + 1_000,
			},
			{
				name: "Run tests",
				number: 2,
				conclusion: init.conclusion ?? "success",
				startedAtMs: startedAtMs + 1_000,
				completedAtMs: startedAtMs + init.runMs,
			},
		],
		billed: hosted,
	};
}

/**
 * Fourteen daily runs of workflow `CI`: `test` alternates between
 * `ubuntu-latest` (six minutes) and Depot (three), `lint` is a billed
 * twenty-second job, and every hosted job waits two minutes for a runner.
 * Run 5 failed `test` on its first attempt and passed on the second.
 */
export function twoWeeksOfRuns(nowMs: number): readonly InsightRun[] {
	const runs: InsightRun[] = [];
	for (let day = 14; day >= 1; day -= 1) {
		const id = 1000 + day;
		const createdAtMs = nowMs - day * DAY;
		const onDepot = day % 2 === 0;
		const attempts = day === 5 ? [1, 2] : [1];
		for (const attempt of attempts) {
			const at = createdAtMs + (attempt - 1) * 30 * MINUTE;
			const failed = day === 5 && attempt === 1;
			const jobs = [
				job({
					id: id * 10 + attempt * 2,
					name: "test",
					label: onDepot ? "depot-ubuntu-24.04" : "ubuntu-latest",
					queuedAtMs: at,
					waitMs: onDepot ? 5_000 : 2 * MINUTE,
					runMs: onDepot ? 3 * MINUTE : 6 * MINUTE,
					conclusion: failed ? "failure" : "success",
				}),
				job({
					id: id * 10 + attempt * 2 + 1,
					name: "lint",
					label: "ubuntu-latest",
					queuedAtMs: at,
					waitMs: 2 * MINUTE,
					runMs: 20_000,
				}),
			];
			const completedAtMs = Math.max(
				...jobs.map((entry) => entry.completedAtMs ?? 0),
			);
			runs.push({
				id,
				attempt,
				repository: HISTORY_REPOSITORY,
				workflow: "CI",
				workflowPath: ".github/workflows/ci.yml",
				event: day % 3 === 0 ? "pull_request" : "push",
				branch: day % 3 === 0 ? `feature-${day}` : "main",
				defaultBranch: "main",
				headSha: `${String(day).padStart(2, "0")}${"a".repeat(38)}`,
				actor: day % 2 === 0 ? "octocat" : "hubot",
				conclusion: failed ? "failure" : "success",
				createdAtMs: at,
				completedAtMs,
				jobs,
				title: `change ${day}`,
			});
		}
	}
	return runs;
}

const iso = (ms: number | undefined): string | null =>
	ms === undefined ? null : new Date(ms).toISOString();

function restJob(run: InsightRun, entry: InsightJob) {
	return {
		id: entry.id,
		run_id: run.id,
		run_attempt: run.attempt,
		name: entry.name,
		workflow_name: run.workflow,
		head_branch: run.branch,
		head_sha: run.headSha,
		status: "completed",
		conclusion: entry.conclusion,
		labels: entry.labels,
		runner_name: entry.runnerName ?? null,
		runner_group_name: entry.runnerGroup ?? null,
		created_at: iso(entry.queuedAtMs),
		started_at: iso(entry.startedAtMs),
		completed_at: iso(entry.completedAtMs),
		steps: entry.steps.map((step) => ({
			name: step.name,
			number: step.number,
			status: "completed",
			conclusion: step.conclusion,
			started_at: iso(step.startedAtMs),
			completed_at: iso(step.completedAtMs),
		})),
	};
}

function restRun(run: InsightRun, firstCreatedAtMs: number) {
	return {
		id: run.id,
		run_attempt: run.attempt,
		name: run.workflow,
		path: run.workflowPath,
		event: run.event,
		head_branch: run.branch,
		head_sha: run.headSha,
		status: "completed",
		conclusion: run.conclusion,
		// The run's creation; this attempt began at run_started_at.
		created_at: iso(firstCreatedAtMs),
		run_started_at: iso(run.createdAtMs),
		updated_at: iso(run.completedAtMs),
		display_title: run.title ?? "",
		actor: { login: run.actor },
	};
}

export type FakeGithub = Readonly<{ execFile: CiRunExec; asked: string[] }>;

/**
 * `gh` over `runs`: the repository, the run list (each run at its latest
 * attempt, newest first) and each attempt's jobs. `gh auth token` answers
 * `token` when one is given.
 */
export function fakeGithub(
	runs: readonly InsightRun[],
	options: Readonly<{ private: boolean; token?: string }> = { private: true },
): FakeGithub {
	const asked: string[] = [];
	const latest = new Map<number, InsightRun>();
	const created = new Map<number, number>();
	for (const run of runs) {
		if ((latest.get(run.id)?.attempt ?? 0) < run.attempt)
			latest.set(run.id, run);
		created.set(
			run.id,
			Math.min(created.get(run.id) ?? run.createdAtMs, run.createdAtMs),
		);
	}
	const listed = [...latest.values()].sort(
		(left, right) => right.createdAtMs - left.createdAtMs,
	);
	const execFile: CiRunExec = async (file, args) => {
		asked.push([file, ...args].join(" "));
		if (args[0] === "auth" && args[1] === "token") {
			if (options.token === undefined) throw new Error("not logged in");
			return { stdout: `${options.token}\n`, stderr: "" };
		}
		const path = args[1] ?? "";
		const repo = `repos/${HISTORY_REPOSITORY}`;
		if (path === repo)
			return {
				stdout: JSON.stringify({
					full_name: HISTORY_REPOSITORY,
					private: options.private,
					default_branch: "main",
				}),
				stderr: "",
			};
		const list = /actions\/runs\?per_page=(\d+)$/u.exec(path);
		if (list)
			return {
				stdout: JSON.stringify({
					total_count: listed.length,
					workflow_runs: listed
						.slice(0, Number(list[1]))
						.map((run) => restRun(run, created.get(run.id) ?? run.createdAtMs)),
				}),
				stderr: "",
			};
		const jobs = /actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/u.exec(path);
		if (jobs) {
			const run = runs.find(
				(entry) =>
					entry.id === Number(jobs[1]) && entry.attempt === Number(jobs[2]),
			);
			return {
				stdout: JSON.stringify({
					total_count: run?.jobs.length ?? 0,
					jobs: run ? run.jobs.map((entry) => restJob(run, entry)) : [],
				}),
				stderr: "",
			};
		}
		throw new Error(`unexpected gh call: ${args.join(" ")}`);
	};
	return { execFile, asked };
}
