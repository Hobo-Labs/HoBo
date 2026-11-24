import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	assignmentBlocksRunnerTeardown,
	correlateRunnerOnRun,
	evaluateRunnerTeardownGuard,
	RUNNER_EXECUTING_JOB_STATUSES,
} from "../src/jit-runner-correlation.js";

const runnerName = "hobo-runner";
const runnerId = 42;
const job = (id: number, status: string) => ({
	id,
	run_id: 9,
	status,
	runner_name: runnerName,
	runner_id: runnerId,
});

describe("runner correlation prioritizes active work", () => {
	it("does not let a completed reserved job mask an executing sibling", () => {
		const result = correlateRunnerOnRun(
			[job(1, "completed"), job(2, "in_progress")],
			1,
			runnerName,
			runnerId,
		);
		expect(result).toEqual({
			kind: "served-other",
			jobId: 2,
			status: "in_progress",
		});
	});

	it("does not let an expired queued reservation mask an executing sibling", () => {
		const result = correlateRunnerOnRun(
			[job(1, "queued"), job(2, "waiting")],
			1,
			runnerName,
			runnerId,
		);
		expect(result).toEqual({
			kind: "served-other",
			jobId: 2,
			status: "waiting",
		});
		if (result.kind === "unassigned") throw new Error("missing assignment");
		expect(
			assignmentBlocksRunnerTeardown(
				{ jobId: result.jobId, runId: 9, status: result.status },
				0,
				10_000_000,
			),
		).toBe(true);
	});

	it("keeps teardown blocked when GitHub reports a live sibling on the preferred run", async () => {
		const api = {
			async request(_installationId: number, path: string) {
				if (path.includes("/actions/runs/9/jobs")) {
					return Response.json({
						jobs: [job(1, "completed"), job(2, "in_progress")],
					});
				}
				if (path.includes("/actions/runs?"))
					return Response.json({ workflow_runs: [] });
				throw new Error(`unexpected GitHub request ${path}`);
			},
		};
		expect(
			await evaluateRunnerTeardownGuard(
				api,
				{
					installationId: 1,
					repository: "org/repo",
					runnerName,
					runnerId,
					reservedJobId: 1,
					servedJobId: 0,
					preferRunIds: [9],
					boundSinceMs: 0,
					nowMs: 10_000_000,
				},
				{ failClosed: true, observeServedJob: false },
			),
		).toBe(true);
	});

	it("prefers a reserved executing job when multiple matched jobs execute", () => {
		expect(
			correlateRunnerOnRun(
				[job(2, "in_progress"), job(1, "waiting")],
				1,
				runnerName,
				runnerId,
			),
		).toEqual({ kind: "served-reserved", jobId: 1, status: "waiting" });
	});

	it("keeps any matched executing job visible regardless of ordering and reservation", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.constantFrom(
						"completed",
						"queued",
						"in_progress",
						"waiting",
						"pending",
						"requested",
					),
					{ maxLength: 25 },
				),
				fc.constantFrom("in_progress", "waiting", "pending", "requested"),
				fc.nat(),
				(statuses, activeStatus, choice) => {
					const jobs = statuses.map((status, index) => job(index + 1, status));
					const live = job(jobs.length + 1, activeStatus);
					jobs.splice(choice % (jobs.length + 1), 0, live);
					const reserved = 1 + (choice % jobs.length);
					const result = correlateRunnerOnRun(
						jobs,
						reserved,
						runnerName,
						runnerId,
					);
					expect(result.kind).not.toBe("unassigned");
					if (result.kind === "unassigned")
						throw new Error("missing assignment");
					expect(RUNNER_EXECUTING_JOB_STATUSES.has(result.status)).toBe(true);
					expect(
						assignmentBlocksRunnerTeardown(
							{ jobId: result.jobId, runId: 9, status: result.status },
							0,
							10_000_000,
						),
					).toBe(true);
				},
			),
			{ seed: 614467, numRuns: 500 },
		);
	});
});
