import { create } from "@bufbuild/protobuf";
import { LeaseSchema } from "@hobo/ci";
import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	createOrphanJobTracker,
	type OrphanJobCandidate,
	orphanJobCandidateForLease,
} from "../src/isolated-worker/orphan-jobs.js";

const CANDIDATE = {
	repository: "Org/Repo",
	installationId: 10,
	runId: 900,
	jobId: 100,
	runnerId: 42,
	runnerName: "hobo-runner",
	detectedAtMs: 0,
} as const satisfies OrphanJobCandidate;

type Call = Readonly<{
	installationId: number;
	path: string;
	method: string;
}>;

function githubWith(handler: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const github: GithubTransport = {
		request: async (installationId, path, method = "GET") => {
			const call = { installationId, path, method };
			calls.push(call);
			return handler(call);
		},
	};
	return { github, calls };
}

function job(
	status: string,
	runnerName: string | null = "hobo-runner",
	jobId = 100,
	runId = 900,
) {
	return Response.json({
		id: jobId,
		run_id: runId,
		status,
		labels: ["hobo"],
		runner_name: runnerName,
		run_attempt: 2,
	});
}

function run(status: string, event = "pull_request", runId = 900) {
	return Response.json({
		id: runId,
		run_attempt: 2,
		event,
		head_sha: "a".repeat(40),
		head_branch: "branch",
		path: ".github/workflows/ci.yml",
		display_title: "CI",
		status,
		conclusion: status === "completed" ? "cancelled" : null,
		run_started_at: "2026-11-04T12:00:00.000Z",
		updated_at: "2026-11-04T12:01:00.000Z",
		actor: { id: 1 },
		repository: { id: 101, private: false },
		head_repository: { id: 101 },
		pull_requests: [],
	});
}

function successfulRelease(
	call: Call,
	runStatus: string,
	event = "pull_request",
) {
	if (call.path.endsWith("/actions/jobs/100")) return job("in_progress");
	if (call.method === "DELETE") return new Response(null, { status: 422 });
	if (call.path.endsWith("/force-cancel"))
		return new Response(null, { status: 202 });
	if (call.path.endsWith("/actions/runs/900")) return run(runStatus, event);
	if (call.path.endsWith("/rerun-failed-jobs"))
		return new Response(null, { status: 201 });
	return new Response(null, { status: 500 });
}

describe("isolated worker orphan jobs", () => {
	it.each([
		{ status: "completed", reason: "completed" },
		{ status: "queued", reason: "queued" },
	])("drops a $status job", async ({ status, reason }) => {
		const { github, calls } = githubWith(() => job(status));
		const log = vi.fn();
		const tracker = createOrphanJobTracker({ github, now: () => 0, log });
		tracker.enqueue(CANDIDATE);

		await tracker.reconcile();

		expect(calls).toHaveLength(1);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_orphan_job_dropped",
			expect.objectContaining({ reason, jobId: 100 }),
		);
	});

	it("waits for the confirmation grace while the same runner is in progress", async () => {
		const { github, calls } = githubWith(() => job("in_progress"));
		const log = vi.fn();
		const tracker = createOrphanJobTracker({
			github,
			now: () => 59_999,
			log,
		});
		tracker.enqueue(CANDIDATE);

		await tracker.reconcile();

		expect(calls).toHaveLength(1);
		expect(log).not.toHaveBeenCalledWith(
			"hobo_ci_orphan_job_confirmed",
			expect.anything(),
		);
		expect(calls.some((call) => call.method === "DELETE")).toBe(false);
	});

	it("deletes, force-cancels, and reruns a confirmed pull request orphan once", async () => {
		let now = 60_000;
		let runStatus = "in_progress";
		const { github, calls } = githubWith((call) =>
			successfulRelease(call, runStatus),
		);
		const log = vi.fn();
		const tracker = createOrphanJobTracker({ github, now: () => now, log });
		tracker.enqueue(CANDIDATE);

		await tracker.reconcile();
		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			"GET /repos/Org/Repo/actions/jobs/100",
			"DELETE /repos/Org/Repo/actions/runners/42",
			"POST /repos/Org/Repo/actions/runs/900/force-cancel",
			"GET /repos/Org/Repo/actions/runs/900",
		]);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_orphan_job_confirmed",
			expect.objectContaining({ jobId: 100, runnerId: 42 }),
		);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_orphan_runner_delete",
			expect.objectContaining({ status: 422 }),
		);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_orphan_run_force_cancel",
			expect.objectContaining({ status: 202 }),
		);

		runStatus = "completed";
		now = 61_000;
		await tracker.reconcile();
		await tracker.reconcile();

		expect(
			calls.filter((call) => call.path.endsWith("/force-cancel")),
		).toHaveLength(1);
		expect(
			calls.filter((call) => call.path.endsWith("/rerun-failed-jobs")),
		).toHaveLength(1);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_orphan_run_rerun",
			expect.objectContaining({ status: 201, runAttempt: 2 }),
		);
	});

	it("releases the cross-assigned actual job and leaves the reserved job untouched", async () => {
		const lease = create(LeaseSchema, {
			id: "00000000-0000-4000-8000-000000000001",
			repository: "Org/Repo",
			installationId: 10,
			jobId: 100,
			actualJobId: 200,
			originalRunId: 900,
			runnerId: 42,
			runnerName: "hobo-runner",
		});
		const candidate = orphanJobCandidateForLease(lease, 0);
		if (!candidate) throw new Error("fixture candidate");
		expect(candidate.jobId).toBe(200);
		const { github, calls } = githubWith((call) => {
			if (call.path.endsWith("/actions/jobs/200"))
				return job("in_progress", "hobo-runner", 200, 901);
			if (call.method === "DELETE") return new Response(null, { status: 422 });
			if (call.path.endsWith("/actions/runs/901/force-cancel"))
				return new Response(null, { status: 202 });
			if (call.path.endsWith("/actions/runs/901"))
				return run("completed", "pull_request", 901);
			if (call.path.endsWith("/actions/runs/901/rerun-failed-jobs"))
				return new Response(null, { status: 201 });
			return new Response(null, { status: 500 });
		});
		const tracker = createOrphanJobTracker({ github, now: () => 60_000 });
		tracker.enqueue(candidate);

		await tracker.reconcile();

		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			"GET /repos/Org/Repo/actions/jobs/200",
			"DELETE /repos/Org/Repo/actions/runners/42",
			"POST /repos/Org/Repo/actions/runs/901/force-cancel",
			"GET /repos/Org/Repo/actions/runs/901",
			"POST /repos/Org/Repo/actions/runs/901/rerun-failed-jobs",
		]);
		expect(calls.some((call) => call.path.includes("/jobs/100"))).toBe(false);
		expect(calls.some((call) => call.path.includes("/runs/900"))).toBe(false);
	});

	it("skips rerun for merge_group and asks for the pull request to be requeued", async () => {
		const { github, calls } = githubWith((call) =>
			successfulRelease(call, "completed", "merge_group"),
		);
		const log = vi.fn();
		const tracker = createOrphanJobTracker({
			github,
			now: () => 60_000,
			log,
		});
		tracker.enqueue(CANDIDATE);

		await tracker.reconcile();

		expect(calls.some((call) => call.path.endsWith("/rerun-failed-jobs"))).toBe(
			false,
		);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_orphan_run_rerun_skipped",
			expect.objectContaining({
				event: "merge_group",
				message: "pull request needs re-queueing",
			}),
		);
	});

	it("drops a job assigned to a different runner", async () => {
		const { github, calls } = githubWith(() =>
			job("in_progress", "another-runner"),
		);
		const log = vi.fn();
		const tracker = createOrphanJobTracker({
			github,
			now: () => 60_000,
			log,
		});
		tracker.enqueue(CANDIDATE);

		await tracker.reconcile();

		expect(calls).toHaveLength(1);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_orphan_job_dropped",
			expect.objectContaining({ reason: "runner-mismatch" }),
		);
	});

	it("retries a GitHub 5xx on the next tick", async () => {
		let now = 0;
		let failures = 1;
		const { github, calls } = githubWith((call) => {
			if (call.path.endsWith("/actions/jobs/100") && failures > 0) {
				failures--;
				return new Response(null, { status: 500 });
			}
			return successfulRelease(call, "completed", "push");
		});
		const tracker = createOrphanJobTracker({ github, now: () => now });
		tracker.enqueue(CANDIDATE);

		await tracker.reconcile();
		expect(calls).toHaveLength(1);
		now = 60_000;
		await tracker.reconcile();

		expect(
			calls.filter((call) => call.path.endsWith("/actions/jobs/100")),
		).toHaveLength(2);
		expect(
			calls.filter((call) => call.path.endsWith("/rerun-failed-jobs")),
		).toHaveLength(1);
	});

	it("expires a candidate after 30 minutes without calling GitHub", async () => {
		const { github, calls } = githubWith(
			() => new Response(null, { status: 500 }),
		);
		const log = vi.fn();
		const tracker = createOrphanJobTracker({
			github,
			now: () => 1_800_000,
			log,
		});
		tracker.enqueue(CANDIDATE);

		await tracker.reconcile();

		expect(calls).toHaveLength(0);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_orphan_job_dropped",
			expect.objectContaining({ reason: "expired" }),
		);
	});
});
