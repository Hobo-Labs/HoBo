import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	listInProgressWorkflowRunIds,
	listRunWorkflowJobs,
} from "../src/github.js";
import {
	evaluateRunnerTeardownGuard,
	resolveRunnerAssignedJob,
} from "../src/jit-runner-correlation.js";

const fields = {
	installationId: 1,
	repository: "org/repo",
	runnerName: "hobo-runner",
	runnerId: 42,
	reservedJobId: 1,
	servedJobId: 0,
	preferRunIds: [9],
	boundSinceMs: 0,
	nowMs: 10_000_000,
};
const makeJob = (id: number, assigned: boolean) => ({
	id,
	run_id: 9,
	status: assigned ? "in_progress" : "completed",
	runner_name: assigned ? "hobo-runner" : "other",
	runner_id: assigned ? 42 : id + 1000,
});
function pages(jobs: ReturnType<typeof makeJob>[]) {
	return {
		async request(_installationId: number, path: string) {
			if (path.includes("/runs/9/jobs?")) {
				const page = path.includes("&page=")
					? Number(path.split("&page=")[1])
					: 1;
				return Response.json({
					jobs: jobs.slice((page - 1) * 100, page * 100),
				});
			}
			if (path.includes("/actions/runs?"))
				return Response.json({ workflow_runs: [] });
			throw new Error(`unexpected GitHub request ${path}`);
		},
	};
}
describe("GitHub runner listing completeness", () => {
	it("finds an assigned job after the first 100 jobs and blocks teardown", async () => {
		const jobs = Array.from({ length: 101 }, (_, index) =>
			makeJob(index + 1, index === 100),
		);
		const api = pages(jobs);
		expect(await listRunWorkflowJobs(api, 1, "org/repo", 9)).toHaveLength(101);
		expect(
			(
				await resolveRunnerAssignedJob(api, 1, "org/repo", "hobo-runner", 42, {
					preferRunIds: [9],
				})
			)?.jobId,
		).toBe(101);
		expect(
			await evaluateRunnerTeardownGuard(api, fields, {
				failClosed: true,
				observeServedJob: false,
			}),
		).toBe(true);
	});
	it("fails closed when a later job page cannot be read", async () => {
		const first = Array.from({ length: 100 }, (_, index) =>
			makeJob(index + 1, false),
		);
		const api = {
			async request(_installationId: number, path: string) {
				if (path.includes("/runs/9/jobs?") && !path.includes("&page="))
					return Response.json({ jobs: first });
				if (path.includes("/runs/9/jobs?"))
					return new Response("", { status: 503 });
				if (path.includes("/actions/runs?"))
					return Response.json({ workflow_runs: [] });
				throw new Error(`unexpected ${path}`);
			},
		};
		await expect(listRunWorkflowJobs(api, 1, "org/repo", 9)).rejects.toThrow(
			/jobs lookup/i,
		);
		expect(
			await evaluateRunnerTeardownGuard(api, fields, {
				failClosed: true,
				observeServedJob: false,
			}),
		).toBe(true);
	});
	it("rejects repeated job pages rather than treating the scan as complete", async () => {
		const first = Array.from({ length: 100 }, (_, index) =>
			makeJob(index + 1, false),
		);
		let calls = 0;
		const api = {
			async request() {
				calls++;
				return Response.json({ jobs: first });
			},
		};
		await expect(listRunWorkflowJobs(api, 1, "org/repo", 9)).rejects.toThrow(
			/duplicate/i,
		);
		expect(calls).toBe(2);
	});
	it("rejects a job from a different run", async () => {
		const api = {
			async request() {
				return Response.json({ jobs: [{ ...makeJob(1, true), run_id: 10 }] });
			},
		};
		await expect(listRunWorkflowJobs(api, 1, "org/repo", 9)).rejects.toThrow(
			/another run/i,
		);
	});
	it("rejects duplicated run IDs across pages", async () => {
		const api = {
			async request(_installationId: number, path: string) {
				return Response.json({
					workflow_runs: path.includes("page=1")
						? [{ id: 10 }, { id: 11 }, { id: 12 }]
						: [{ id: 12 }],
				});
			},
		};
		await expect(
			listInProgressWorkflowRunIds(api, 1, "org/repo", 3),
		).rejects.toThrow(/duplicate/i);
	});
	it("rejects a run page larger than requested", async () => {
		const api = {
			async request() {
				return Response.json({
					workflow_runs: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
				});
			},
		};
		await expect(
			listInProgressWorkflowRunIds(api, 1, "org/repo", 3),
		).rejects.toThrow(/invalid.*page/i);
	});
	it.each([
		false,
		true,
	])("distinguishes an exhausted run listing from a truncated one (extra: %s)", async (extra) => {
		const api = {
			async request(_installationId: number, path: string) {
				if (path.includes("/actions/runs?")) {
					if (path.includes("page=1"))
						return Response.json({
							workflow_runs: [{ id: 10 }, { id: 11 }, { id: 12 }],
						});
					return Response.json({ workflow_runs: extra ? [{ id: 13 }] : [] });
				}
				if (path.includes("/jobs?")) return Response.json({ jobs: [] });
				throw new Error(`unexpected ${path}`);
			},
		};
		const call = resolveRunnerAssignedJob(
			api,
			1,
			"org/repo",
			"hobo-runner",
			42,
			{ preferRunIds: [], inProgressRunLimit: 3 },
		);
		if (extra) await expect(call).rejects.toThrow(/incomplete/i);
		else await expect(call).resolves.toBeUndefined();
	});
	it("finds an assigned job at generated positions beyond page one", async () => {
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 100, max: 250 }), async (index) => {
				const jobs = Array.from({ length: index + 1 }, (_, i) =>
					makeJob(i + 1, i === index),
				);
				const result = await resolveRunnerAssignedJob(
					pages(jobs),
					1,
					"org/repo",
					"hobo-runner",
					42,
					{ preferRunIds: [9] },
				);
				expect(result?.jobId).toBe(index + 1);
			}),
			{ seed: 614469, numRuns: 100 },
		);
	});
});
it("preserves a queued candidate as incomplete when the run limit is reached", async () => {
	const api = {
		async request(_installationId: number, path: string) {
			if (path.includes("/runs/9/jobs?"))
				return Response.json({
					jobs: [
						{
							id: 1,
							run_id: 9,
							status: "queued",
							runner_id: 42,
							runner_name: "hobo-runner",
						},
					],
				});
			if (path.includes("/actions/runs?"))
				return Response.json({
					workflow_runs: path.includes("page=1")
						? [{ id: 10 }, { id: 11 }, { id: 12 }]
						: [{ id: 13 }],
				});
			if (path.includes("/jobs?")) return Response.json({ jobs: [] });
			throw new Error(`unexpected ${path}`);
		},
	};
	const result = await resolveRunnerAssignedJob(
		api,
		1,
		"org/repo",
		"hobo-runner",
		42,
		{ preferRunIds: [9], inProgressRunLimit: 3 },
	);
	expect(result).toEqual({
		jobId: 1,
		runId: 9,
		status: "queued",
		incomplete: true,
	});
});
it("refuses an invalid in-progress run limit", async () => {
	const api = {
		async request() {
			return Response.json({ workflow_runs: [] });
		},
	};
	await expect(
		resolveRunnerAssignedJob(api, 1, "org/repo", "hobo-runner", 42, {
			inProgressRunLimit: 0,
		}),
	).rejects.toThrow(/limit/i);
});
