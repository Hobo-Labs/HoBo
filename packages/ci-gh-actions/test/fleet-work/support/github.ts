/**
 * A fake GitHub REST transport for the `github-actions-job` work kind: one
 * installation, repositories with runs and jobs the test sets, the run
 * detail and workflow file the work source reads, and the job lookup
 * `stillWanted` makes. Every request is recorded. Unknown paths answer 404.
 */
import type { JsonValue } from "@hobo/core";
import type { GithubTransport } from "../../../src/github.js";

export type FakeRun = {
	id: number;
	attempt: number;
	event: string;
	status: "queued" | "in_progress" | "completed";
	headBranch: string;
	headSha: string;
	path: string;
	actorId: number;
	triggeringActorId?: number;
	headRepository: string | null;
	pullRequest?: number;
	workflow: string;
};

export type FakeJob = {
	id: number;
	runId: number;
	attempt: number;
	status: "queued" | "in_progress" | "completed";
	name: string;
	labels: string[];
	runnerName: string | null;
	createdAt: string;
};

export type FakeGithub = GithubTransport & {
	readonly repository: string;
	readonly runs: FakeRun[];
	readonly jobs: FakeJob[];
	readonly requests: string[];
	/** Paths answered with this status instead. */
	readonly failing: Map<string, number>;
};

const json = <T extends JsonValue>(status: number, body: T) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

export function createFakeGithub(repository = "acme/app"): FakeGithub {
	const runs: FakeRun[] = [];
	const jobs: FakeJob[] = [];
	const requests: string[] = [];
	const failing = new Map<string, number>();

	const runBody = (run: FakeRun) => ({
		id: run.id,
		run_attempt: run.attempt,
		event: run.event,
		status: run.status,
		conclusion: null,
		head_branch: run.headBranch,
		head_sha: run.headSha,
		path: run.path,
		run_started_at: null,
		actor: { id: run.actorId },
		triggering_actor: { id: run.triggeringActorId ?? run.actorId },
		repository: { full_name: repository },
		head_repository:
			run.headRepository === null ? null : { full_name: run.headRepository },
		pull_requests:
			run.pullRequest === undefined ? [] : [{ number: run.pullRequest }],
	});

	const jobBody = (job: FakeJob) => ({
		id: job.id,
		run_id: job.runId,
		run_attempt: job.attempt,
		status: job.status,
		labels: job.labels,
		runner_name: job.runnerName,
		name: job.name,
		conclusion: null,
		created_at: job.createdAt,
	});

	return {
		repository,
		runs,
		jobs,
		requests,
		failing,
		async request(_installationId, path, method = "GET") {
			requests.push(`${method} ${path}`);
			const forced = failing.get(path);
			if (forced !== undefined) return json(forced, { message: "forced" });
			const base = `/repos/${repository}/actions`;
			const url = new URL(path, "https://api.github.invalid");
			if (url.pathname === `${base}/runs`) {
				const status = url.searchParams.get("status");
				return json(200, {
					workflow_runs: runs
						.filter((run) => status === null || run.status === status)
						.map(runBody),
				});
			}
			const runJobs =
				/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs$/u.exec(
					url.pathname,
				);
			if (runJobs !== null)
				return json(200, {
					jobs: jobs
						.filter((job) => job.runId === Number(runJobs[1]))
						.map(jobBody),
				});
			const run = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)$/u.exec(
				url.pathname,
			);
			if (run !== null) {
				const found = runs.find((entry) => entry.id === Number(run[1]));
				return found === undefined
					? json(404, { message: "Not Found" })
					: json(200, runBody(found));
			}
			const job = /^\/repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)$/u.exec(
				url.pathname,
			);
			if (job !== null) {
				const found = jobs.find((entry) => entry.id === Number(job[1]));
				return found === undefined
					? json(404, { message: "Not Found" })
					: json(200, jobBody(found));
			}
			const contents = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/u.exec(
				url.pathname,
			);
			if (contents !== null) {
				const ref = url.searchParams.get("ref");
				const found = runs.find(
					(entry) => entry.path === contents[1] && entry.headSha === ref,
				);
				return found === undefined
					? json(404, { message: "Not Found" })
					: json(200, {
							encoding: "base64",
							content: Buffer.from(found.workflow).toString("base64"),
						});
			}
			return json(404, { message: "Not Found" });
		},
	};
}

/** An internal push run with one queued `hobo` job. */
export function queueJob(
	github: FakeGithub,
	init: Partial<FakeRun> &
		Partial<Pick<FakeJob, "name" | "labels">> & {
			jobId?: number;
		} = {},
) {
	const id = init.id ?? 100 + github.runs.length;
	const run: FakeRun = {
		id,
		attempt: init.attempt ?? 1,
		event: init.event ?? "push",
		status: init.status ?? "queued",
		headBranch: init.headBranch ?? "main",
		headSha: init.headSha ?? "a".repeat(40),
		path: init.path ?? ".github/workflows/ci.yml",
		actorId: init.actorId ?? 2,
		headRepository:
			init.headRepository === undefined
				? github.repository
				: init.headRepository,
		workflow: init.workflow ?? "on: push\njobs: {}\n",
	};
	if (init.triggeringActorId !== undefined)
		run.triggeringActorId = init.triggeringActorId;
	if (init.pullRequest !== undefined) run.pullRequest = init.pullRequest;
	const job: FakeJob = {
		id: init.jobId ?? 9000 + github.jobs.length,
		runId: id,
		attempt: run.attempt,
		status: "queued",
		name: init.name ?? "build",
		labels: init.labels ?? ["hobo"],
		runnerName: null,
		createdAt: "2026-11-13T11:59:00.000Z",
	};
	github.runs.push(run);
	github.jobs.push(job);
	return { run, job };
}
