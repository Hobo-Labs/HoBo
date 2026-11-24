import { create } from "@bufbuild/protobuf";
import { LeaseSchema } from "@hobo/ci";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import {
	correlateRunnerOnRun,
	runnerMatchesGitHubJob,
	servedGitHubJobBlocksSettlement,
} from "../src/jit-runner-correlation.js";
import { adoptRunnerAssignment } from "../src/runner-lease-adoption.js";

const name = "hobo-runner";
it("refuses a same-named runner when both positive runner IDs conflict", () => {
	const lease = { runnerId: 42, runnerName: name };
	const foreign = {
		id: 2,
		run_id: 9,
		status: "in_progress",
		runner_id: 43,
		runner_name: name,
	};
	expect(runnerMatchesGitHubJob(lease, foreign)).toBe(false);
	expect(servedGitHubJobBlocksSettlement(lease, foreign)).toBe(false);
	expect(correlateRunnerOnRun([foreign], 1, name, 42)).toEqual({
		kind: "unassigned",
	});
});
it("uses equal positive IDs even if runner names differ", () => {
	expect(
		runnerMatchesGitHubJob(
			{ runnerId: 42, runnerName: name },
			{ runner_id: 42, runner_name: "renamed" },
		),
	).toBe(true);
});
it.each([
	{ runnerId: 42, jobId: null },
	{ runnerId: 42, jobId: 0 },
	{ runnerId: 0, jobId: 43 },
	{ runnerId: 0, jobId: null },
])("uses a nonempty runner name if an ID is missing: %j", ({
	runnerId,
	jobId,
}) => {
	expect(
		runnerMatchesGitHubJob(
			{ runnerId, runnerName: ` ${name} ` },
			{ runner_id: jobId, runner_name: ` ${name} ` },
		),
	).toBe(true);
	expect(
		runnerMatchesGitHubJob(
			{ runnerId, runnerName: " " },
			{ runner_id: jobId, runner_name: " " },
		),
	).toBe(false);
});
it("rejects generated unequal positive IDs even when names match", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 1, max: 1_000_000 }),
			fc.integer({ min: 1, max: 1_000_000 }),
			(id, other) => {
				fc.pre(id !== other);
				expect(
					runnerMatchesGitHubJob(
						{ runnerId: id, runnerName: name },
						{ runner_id: other, runner_name: name },
					),
				).toBe(false);
				expect(
					correlateRunnerOnRun(
						[
							{
								id: 2,
								run_id: 9,
								status: "in_progress",
								runner_id: other,
								runner_name: name,
							},
						],
						1,
						name,
						id,
					),
				).toEqual({ kind: "unassigned" });
			},
		),
		{ seed: 614471, numRuns: 100 },
	);
});
it("does not transfer custody or withdraw a reservation to a different runner with the same name", async () => {
	const lease = create(LeaseSchema, {
		id: "lease",
		jobId: 1,
		actualJobId: 0,
		originalRunId: 9,
		runnerName: name,
		runnerId: 42,
		state: "running",
		repository: "org/repo",
		installationId: 1,
	});
	const transition = vi.fn(async () => lease);
	const withdrawQueuedJob = vi.fn(async () => true);
	const api = {
		async request(_id: number, path: string) {
			if (path.includes("/runs/9/jobs"))
				return Response.json({
					jobs: [
						{
							id: 2,
							run_id: 9,
							status: "in_progress",
							runner_id: 43,
							runner_name: name,
						},
					],
				});
			if (path.includes("/actions/runs?"))
				return Response.json({ workflow_runs: [] });
			throw new Error(`unexpected request ${path}`);
		},
	};
	const result = await adoptRunnerAssignment(
		{ get: async () => lease, transition, withdrawQueuedJob },
		api,
		lease,
		"2026-11-12T12:01:00.000Z",
	);
	expect(result.assignment).toBeUndefined();
	expect(transition).not.toHaveBeenCalled();
	expect(withdrawQueuedJob).not.toHaveBeenCalled();
});
