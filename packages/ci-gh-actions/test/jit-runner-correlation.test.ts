import { describe, expect, it, vi } from "vitest";
import * as githubModule from "../src/github.js";
import {
	correlateRunnerOnRun,
	resolveRunnerAssignedJob,
} from "../src/jit-runner-correlation.js";

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
