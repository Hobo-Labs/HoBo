import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	createStallJobRecovery,
	stallJobRerunAllowed,
	type StallRecoveryRecord,
} from "../src/isolated-worker/stall-job-recovery.js";

type Call = Readonly<{
	path: string;
	method: string;
}>;

const RECORD = {
	repository: "Org/Repo",
	installationId: 10,
	runId: 900,
	jobId: 100,
	runnerName: "hobo-runner",
	stallReason: "memory-psi",
	registeredAtMs: 0,
} as const satisfies StallRecoveryRecord;

function githubWith(handler: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const github: GithubTransport = {
		request: async (_installationId, path, method = "GET") => {
			const call = { path, method };
			calls.push(call);
			return handler(call);
		},
	};
	return { github, calls };
}

function job(status: string, runnerName = "hobo-runner", runId = 900) {
	return Response.json({
		id: 100,
		run_id: runId,
		status,
		labels: ["hobo"],
		runner_name: runnerName,
		run_attempt: 1,
	});
}

function run(
	event: string,
	headBranch: string | null,
	runId = 900,
	createdAt = "2026-11-11T10:00:00.000Z",
) {
	return Response.json({
		id: runId,
		run_attempt: 1,
		event,
		head_sha: "a".repeat(40),
		head_branch: headBranch,
		path: ".github/workflows/ci.yml",
		display_title: "CI",
		status: "completed",
		conclusion: "failure",
		created_at: createdAt,
		run_started_at: createdAt,
		updated_at: createdAt,
		actor: { id: 1 },
		repository: { id: 101, private: false },
		head_repository: { id: 101 },
		pull_requests: [],
	});
}

describe("stall job recovery", () => {
	it("never reruns or force-cancels a pull_request run from another branch", async () => {
		const { github, calls } = githubWith((call) => {
			if (call.path.endsWith("/actions/jobs/100")) return job("completed");
			if (call.path.endsWith("/actions/runs/900")) return run("pull_request", "feature/x");
			return new Response(null, { status: 500 });
		});
		const log = vi.fn();
		const recovery = createStallJobRecovery({ github, now: () => 0, log });
		recovery.register(RECORD);

		await recovery.reconcile();

		expect(calls.some((call) => call.path.includes("force-cancel"))).toBe(false);
		expect(
			calls.some((call) => call.path.endsWith("/rerun-failed-jobs")),
		).toBe(false);
		expect(calls.some((call) => call.path.endsWith("/jobs/100/rerun"))).toBe(
			false,
		);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_stall_job_annotated",
			expect.objectContaining({ jobId: 100, event: "pull_request" }),
		);
	});

	it("never calls workflow force-cancel", async () => {
		const { github, calls } = githubWith((call) => {
			if (call.path.endsWith("/actions/jobs/100")) return job("completed");
			if (call.path.endsWith("/actions/runs/900")) return run("push", "main");
			if (call.path.endsWith("/jobs/100/rerun") && call.method === "POST")
				return new Response(null, { status: 201 });
			return new Response(null, { status: 500 });
		});
		const recovery = createStallJobRecovery({ github, now: () => 60_000 });
		recovery.register(RECORD);
		await recovery.reconcile();
		expect(calls.some((call) => call.path.includes("force-cancel"))).toBe(false);
		expect(
			calls.some((call) => call.path.endsWith("/rerun-failed-jobs")),
		).toBe(false);
	});

	it("reruns one main push job within fifteen minutes and never twice", async () => {
		let calls: Call[] = [];
		const { github } = githubWith((call) => {
			calls.push(call);
			if (call.path.endsWith("/actions/jobs/100")) return job("completed");
			if (call.path.endsWith("/actions/runs/900")) return run("push", "main");
			if (call.path.endsWith("/jobs/100/rerun") && call.method === "POST")
				return new Response(null, { status: 201 });
			return new Response(null, { status: 500 });
		});
		const log = vi.fn();
		const recovery = createStallJobRecovery({ github, now: () => 60_000, log });
		recovery.register(RECORD);
		await recovery.reconcile();

		expect(calls.filter((call) => call.path.endsWith("/jobs/100/rerun"))).toHaveLength(
			1,
		);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_stall_job_rerun",
			expect.objectContaining({ status: 201 }),
		);

		calls = [];
		recovery.register(RECORD);
		await recovery.reconcile();
		expect(calls.filter((call) => call.path.endsWith("/jobs/100/rerun"))).toHaveLength(
			0,
		);
	});

	it("skips rerun outside the fifteen-minute window", () => {
		const created = Date.parse("2026-11-11T10:00:00.000Z");
		expect(
			stallJobRerunAllowed(
				{ event: "push", head_branch: "main" },
				"main",
				created,
				created + 16 * 60_000,
				15 * 60_000,
			),
		).toMatchObject({ allowed: false });
	});

	it("does nothing when stall recovery was never registered", async () => {
		const { github, calls } = githubWith(
			() => new Response(null, { status: 500 }),
		);
		const recovery = createStallJobRecovery({ github, now: () => 0 });
		await recovery.reconcile();
		expect(calls).toHaveLength(0);
	});
});
