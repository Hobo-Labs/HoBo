import { describe, expect, it, vi } from "vitest";
import * as githubModule from "../src/github.js";
import {
	assignmentBlocksRunnerTeardown,
	correlateRunnerOnRun,
	resolveRunnerAssignedJob,
	runnerMatchesGitHubJob,
	servedGitHubJobBlocksSettlement,
} from "../src/jit-runner-correlation.js";
import { ISOLATED_JIT_QUEUED_BOUND_GRACE_MS } from "../src/isolated-worker/container-timeout.js";

describe("correlateRunnerOnRun", () => {
	const runnerName = "hobo-00000000-0000-4000-8000-000000000001";
	const runnerId = 42;

	it("returns unassigned when no job names the runner", () => {
		expect(
			correlateRunnerOnRun(
				[
					{
						id: 100,
						run_id: 9,
						status: "queued",
						runner_name: null,
						runner_id: null,
					},
				],
				100,
				runnerName,
				runnerId,
			),
		).toEqual({ kind: "unassigned" });
	});

	it("returns served-other when the runner ran a sibling job on the run", () => {
		expect(
			correlateRunnerOnRun(
				[
					{
						id: 100,
						run_id: 9,
						status: "queued",
						runner_name: null,
						runner_id: null,
					},
					{
						id: 101,
						run_id: 9,
						status: "completed",
						runner_name: runnerName,
						runner_id: runnerId,
					},
				],
				100,
				runnerName,
				runnerId,
			),
		).toEqual({ kind: "served-other", jobId: 101, status: "completed" });
	});

	it("returns served-reserved when GitHub bound the reserved job", () => {
		expect(
			correlateRunnerOnRun(
				[
					{
						id: 100,
						run_id: 9,
						status: "in_progress",
						runner_name: runnerName,
						runner_id: runnerId,
					},
				],
				100,
				runnerName,
				runnerId,
			),
		).toEqual({ kind: "served-reserved", jobId: 100, status: "in_progress" });
	});

	it("resolveRunnerAssignedJob finds an in-progress job on another workflow run", async () => {
		vi.spyOn(githubModule, "listRunWorkflowJobs").mockImplementation(
			async (_api, _i, _r, runId) => {
				if (runId === 900) return [];
				return [
					{
						id: 200,
						run_id: 901,
						status: "in_progress",
						runner_name: runnerName,
						runner_id: runnerId,
					},
				];
			},
		);
		vi.spyOn(githubModule, "listInProgressWorkflowRunIds").mockResolvedValue([
			901,
		]);
		const api = { request: vi.fn() };
		await expect(
			resolveRunnerAssignedJob(api, 1, "org/repo", runnerName, runnerId, {
				reservedJobId: 100,
				preferRunIds: [900],
			}),
		).resolves.toEqual({ jobId: 200, runId: 901, status: "in_progress" });
		vi.restoreAllMocks();
	});
});

describe("settlement custody helpers", () => {
	const runnerName = "hobo-237f4d7d-0700-466a-9140-8cbc4d241cc7";
	const lease = { runnerId: 99, runnerName };

	it("matches by runner name when runner_id is missing", () => {
		expect(
			runnerMatchesGitHubJob(lease, {
				runner_id: null,
				runner_name: runnerName,
			}),
		).toBe(true);
	});

	it("does not block settlement for a queued reserved job on another runner", () => {
		expect(
			servedGitHubJobBlocksSettlement(lease, {
				status: "queued",
				runner_id: null,
				runner_name: null,
			}),
		).toBe(false);
	});

	it("blocks settlement while the served job is in progress on this runner", () => {
		expect(
			servedGitHubJobBlocksSettlement(lease, {
				status: "in_progress",
				runner_id: null,
				runner_name: runnerName,
			}),
		).toBe(true);
	});

	it("blocks teardown for queued-bound jobs inside the grace window", () => {
		const nowMs = Date.parse("2026-11-12T12:03:00.000Z");
		const boundSinceMs = nowMs - (ISOLATED_JIT_QUEUED_BOUND_GRACE_MS - 60_000);
		expect(
			assignmentBlocksRunnerTeardown(
				{ jobId: 1, runId: 2, status: "queued" },
				boundSinceMs,
				nowMs,
			),
		).toBe(true);
	});

	it("releases queued-bound jobs after the grace window", () => {
		const nowMs = Date.parse("2026-11-12T12:10:00.000Z");
		const boundSinceMs =
			nowMs - (ISOLATED_JIT_QUEUED_BOUND_GRACE_MS + 60_000);
		expect(
			assignmentBlocksRunnerTeardown(
				{ jobId: 1, runId: 2, status: "queued" },
				boundSinceMs,
				nowMs,
			),
		).toBe(false);
	});
});
