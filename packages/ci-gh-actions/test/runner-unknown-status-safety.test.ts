import { create } from "@bufbuild/protobuf";
import { LeaseSchema } from "@hobo/ci";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as correlation from "../src/jit-runner-correlation.js";
import { adoptRunnerAssignment } from "../src/runner-lease-adoption.js";

const runnerName = "hobo-runner";
const job = (id: number, run_id: number, status: string) => ({
	id,
	run_id,
	status,
	runner_id: 42,
	runner_name: runnerName,
	labels: [],
});
const fields = {
	installationId: 1,
	repository: "org/repo",
	runnerName,
	runnerId: 42,
	reservedJobId: 1,
	servedJobId: 0,
	preferRunIds: [9],
	boundSinceMs: 0,
	nowMs: 10_000_000,
};
function apiFor(
	runs: Record<number, ReturnType<typeof job>[]>,
	failListing = false,
) {
	return {
		async request(_id: number, path: string) {
			if (path.includes("/actions/runs?")) {
				if (failListing) return new Response("", { status: 503 });
				return Response.json({
					workflow_runs: Object.keys(runs).map((id) => ({ id: Number(id) })),
				});
			}
			const found = path.match(/\/runs\/(\d+)\/jobs/);
			if (found) return Response.json({ jobs: runs[Number(found[1])] ?? [] });
			throw new Error(`unexpected request ${path}`);
		},
	};
}
afterEach(() => vi.restoreAllMocks());
describe("unknown GitHub job status", () => {
	it("prefers an unknown matching status over a queued reservation and retains the runner", () => {
		const selected = correlation.correlateRunnerOnRun(
			[job(1, 9, "queued"), job(2, 9, "future_status")],
			1,
			runnerName,
			42,
		);
		expect(selected).toEqual({
			kind: "served-other",
			jobId: 2,
			status: "future_status",
		});
		const assignment = { jobId: 2, runId: 9, status: "future_status" };
		expect(
			correlation.assignmentBlocksRunnerTeardown(assignment, 0, 10_000_000),
		).toBe(true);
		expect(correlation.runnerHoldsActiveJob(assignment)).toBe(true);
		expect(
			correlation.servedGitHubJobBlocksSettlement(
				{ runnerId: 42, runnerName },
				job(2, 9, "future_status"),
			),
		).toBe(true);
	});
	it("prefers confirmed execution over an unknown status on the same run", () => {
		expect(
			correlation.correlateRunnerOnRun(
				[job(1, 9, "future_status"), job(2, 9, "in_progress")],
				1,
				runnerName,
				42,
			),
		).toEqual({ kind: "served-other", jobId: 2, status: "in_progress" });
	});
	it("prefers a later unknown status over an expired queued match in both teardown modes", async () => {
		const api = apiFor({
			9: [job(1, 9, "queued")],
			10: [job(2, 10, "future_status")],
		});
		await expect(
			correlation.resolveRunnerAssignedJob(api, 1, "org/repo", runnerName, 42, {
				reservedJobId: 1,
				preferRunIds: [9],
			}),
		).resolves.toEqual({ jobId: 2, runId: 10, status: "future_status" });
		for (const failClosed of [true, false])
			expect(
				await correlation.evaluateRunnerTeardownGuard(api, fields, {
					failClosed,
					observeServedJob: false,
				}),
			).toBe(true);
	});
	it("continues past an unknown status to prefer confirmed execution in a later run", async () => {
		const api = apiFor({
			9: [job(1, 9, "future_status")],
			10: [job(2, 10, "in_progress")],
		});
		expect(
			await correlation.resolveRunnerAssignedJob(
				api,
				1,
				"org/repo",
				runnerName,
				42,
				{ reservedJobId: 1, preferRunIds: [9] },
			),
		).toEqual({ jobId: 2, runId: 10, status: "in_progress" });
	});
	it("preserves an unknown match when later lookup fails", async () => {
		const api = apiFor({ 9: [job(1, 9, "future_status")] }, true);
		await expect(
			correlation.resolveRunnerAssignedJob(api, 1, "org/repo", runnerName, 42, {
				preferRunIds: [9],
			}),
		).resolves.toEqual({
			jobId: 1,
			runId: 9,
			status: "future_status",
			incomplete: true,
		});
		expect(
			await correlation.evaluateRunnerTeardownGuard(api, fields, {
				failClosed: false,
				observeServedJob: false,
			}),
		).toBe(true);
	});
	it("retains the runner when direct served-job lookup reports an unknown status", async () => {
		const api = {
			async request(_id: number, path: string) {
				if (path.includes("/actions/runs?"))
					return Response.json({ workflow_runs: [] });
				if (path.includes("/actions/jobs/2"))
					return Response.json(job(2, 9, "future_status"));
				throw new Error(`unexpected request ${path}`);
			},
		};
		for (const failClosed of [true, false])
			expect(
				await correlation.evaluateRunnerTeardownGuard(
					api,
					{ ...fields, preferRunIds: [], servedJobId: 2 },
					{ failClosed },
				),
			).toBe(true);
	});
	it("retains the runner for generated unknown status values", () => {
		fc.assert(
			fc.property(
				fc
					.string()
					.filter(
						(status) =>
							![
								"queued",
								"completed",
								"in_progress",
								"waiting",
								"pending",
								"requested",
							].includes(status),
					),
				(status) => {
					const selection = correlation.correlateRunnerOnRun(
						[job(1, 9, "queued"), job(2, 9, status)],
						1,
						runnerName,
						42,
					);
					expect(selection).toEqual({ kind: "served-other", jobId: 2, status });
					expect(
						correlation.assignmentBlocksRunnerTeardown(
							{ jobId: 2, runId: 9, status },
							0,
							10_000_000,
						),
					).toBe(true);
				},
			),
			{ seed: 614470, numRuns: 100 },
		);
	});
	it("does not transfer custody using an incomplete queued observation", async () => {
		const lease = create(LeaseSchema, {
			id: "lease",
			jobId: 1,
			actualJobId: 0,
			originalRunId: 9,
			runnerName,
			runnerId: 42,
			state: "running",
			repository: "org/repo",
			installationId: 1,
		});
		vi.spyOn(correlation, "resolveRunnerAssignedJob").mockResolvedValue({
			jobId: 2,
			runId: 10,
			status: "queued",
			incomplete: true,
		});
		const transition = vi.fn(async () => lease);
		const withdrawQueuedJob = vi.fn(async () => true);
		const result = await adoptRunnerAssignment(
			{ get: async () => lease, transition, withdrawQueuedJob },
			apiFor({}),
			lease,
			"2026-11-12T12:01:00.000Z",
		);
		expect(result.assignment?.incomplete).toBe(true);
		expect(transition).not.toHaveBeenCalled();
		expect(withdrawQueuedJob).not.toHaveBeenCalled();
	});
	it("does not reassign or withdraw a reservation based only on an unknown status", async () => {
		const lease = create(LeaseSchema, {
			id: "lease",
			jobId: 1,
			actualJobId: 0,
			originalRunId: 9,
			runnerName,
			runnerId: 42,
			state: "running",
			repository: "org/repo",
			installationId: 1,
		});
		vi.spyOn(correlation, "resolveRunnerAssignedJob").mockResolvedValue({
			jobId: 2,
			runId: 10,
			status: "future_status",
		});
		const transition = vi.fn(async () => lease);
		const withdrawQueuedJob = vi.fn(async () => true);
		const store = { get: async () => lease, transition, withdrawQueuedJob };
		const result = await adoptRunnerAssignment(
			store,
			apiFor({}),
			lease,
			"2026-11-12T12:01:00.000Z",
		);
		expect(result.holdsActive).toBe(true);
		expect(result.lease).toBe(lease);
		expect(transition).not.toHaveBeenCalled();
		expect(withdrawQueuedJob).not.toHaveBeenCalled();
	});
});
