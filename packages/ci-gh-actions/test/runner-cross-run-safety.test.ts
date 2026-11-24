import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	evaluateRunnerTeardownGuard,
	RUNNER_EXECUTING_JOB_STATUSES,
	resolveRunnerAssignedJob,
} from "../src/jit-runner-correlation.js";

const api = {
	async request(_installationId: number, path: string) {
		if (path.includes("/runs/9/jobs"))
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
		if (path.includes("/runs/10/jobs"))
			return Response.json({
				jobs: [
					{
						id: 2,
						run_id: 10,
						status: "in_progress",
						runner_id: 42,
						runner_name: "hobo-runner",
					},
				],
			});
		if (path.includes("/actions/runs?"))
			return Response.json({ workflow_runs: [{ id: 10 }] });
		throw new Error(`unexpected GitHub request ${path}`);
	},
};
describe("cross-run runner correlation", () => {
	for (const preferred of [[9, 10], [9]]) {
		it(`finds active work after a queued preferred match: ${preferred}`, async () => {
			const actual = await resolveRunnerAssignedJob(
				api,
				1,
				"org/repo",
				"hobo-runner",
				42,
				{ reservedJobId: 1, preferRunIds: preferred },
			);
			expect(actual).toEqual({ jobId: 2, runId: 10, status: "in_progress" });
			expect(
				await evaluateRunnerTeardownGuard(
					api,
					{
						installationId: 1,
						repository: "org/repo",
						runnerName: "hobo-runner",
						runnerId: 42,
						reservedJobId: 1,
						servedJobId: 0,
						preferRunIds: preferred,
						boundSinceMs: 0,
						nowMs: 10_000_000,
					},
					{ failClosed: true, observeServedJob: false },
				),
			).toBe(true);
		});
	}
});
it("fails closed if assignment lookup fails even when the served job appears completed", async () => {
	const unreliable = {
		async request(_installationId: number, path: string) {
			if (path.includes("/runs/9/jobs"))
				return new Response("", { status: 503 });
			if (path.includes("/actions/jobs/1"))
				return Response.json({
					id: 1,
					run_id: 9,
					status: "completed",
					labels: [],
					runner_id: 42,
					runner_name: "hobo-runner",
				});
			throw new Error(`unexpected GitHub request ${path}`);
		},
	};
	expect(
		await evaluateRunnerTeardownGuard(
			unreliable,
			{
				installationId: 1,
				repository: "org/repo",
				runnerName: "hobo-runner",
				runnerId: 42,
				reservedJobId: 1,
				servedJobId: 1,
				preferRunIds: [9],
				boundSinceMs: 0,
				nowMs: 10_000_000,
			},
			{ failClosed: true },
		),
	).toBe(true);
});

it("keeps a queued partial result and blocks fail-closed teardown when a later lookup fails", async () => {
	const unreliable = {
		async request(_installationId: number, path: string) {
			if (path.includes("/runs/9/jobs"))
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
				return new Response("", { status: 503 });
			throw new Error(`unexpected GitHub request ${path}`);
		},
	};
	expect(
		await resolveRunnerAssignedJob(
			unreliable,
			1,
			"org/repo",
			"hobo-runner",
			42,
			{ reservedJobId: 1, preferRunIds: [9] },
		),
	).toEqual({ jobId: 1, runId: 9, status: "queued", incomplete: true });
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
	expect(
		await evaluateRunnerTeardownGuard(unreliable, fields, {
			failClosed: true,
			observeServedJob: false,
		}),
	).toBe(true);
	expect(
		await evaluateRunnerTeardownGuard(unreliable, fields, {
			failClosed: false,
			observeServedJob: false,
		}),
	).toBe(false);
	expect(
		await evaluateRunnerTeardownGuard(
			unreliable,
			{ ...fields, boundSinceMs: 9_999_999 },
			{ failClosed: false, observeServedJob: false },
		),
	).toBe(true);
});

it("checks the served job on a force-stop path when the scan fails", async () => {
	const unreliable = {
		async request(_installationId: number, path: string) {
			if (path.includes("/runs/9/jobs"))
				return new Response("", { status: 503 });
			if (path.includes("/actions/jobs/1"))
				return Response.json({
					id: 1,
					run_id: 9,
					status: "in_progress",
					labels: [],
					runner_id: 42,
					runner_name: "hobo-runner",
				});
			throw new Error(`unexpected GitHub request ${path}`);
		},
	};
	expect(
		await evaluateRunnerTeardownGuard(
			unreliable,
			{
				installationId: 1,
				repository: "org/repo",
				runnerName: "hobo-runner",
				runnerId: 42,
				reservedJobId: 1,
				servedJobId: 1,
				preferRunIds: [9],
				boundSinceMs: 0,
				nowMs: 10_000_000,
			},
			{ failClosed: false },
		),
	).toBe(true);
});

it("fails closed when the served-job lookup fails even without a numeric runner ID", async () => {
	const unreliable = {
		async request(_installationId: number, path: string) {
			if (path.includes("/runs/9/jobs")) return Response.json({ jobs: [] });
			if (path.includes("/actions/runs?"))
				return Response.json({ workflow_runs: [] });
			if (path.includes("/actions/jobs/1"))
				return new Response("", { status: 503 });
			throw new Error(`unexpected GitHub request ${path}`);
		},
	};
	const fields = {
		installationId: 1,
		repository: "org/repo",
		runnerName: "hobo-runner",
		runnerId: 0,
		reservedJobId: 1,
		servedJobId: 1,
		preferRunIds: [9],
		boundSinceMs: 0,
		nowMs: 10_000_000,
	};
	expect(
		await evaluateRunnerTeardownGuard(unreliable, fields, { failClosed: true }),
	).toBe(true);
	expect(
		await evaluateRunnerTeardownGuard(unreliable, fields, {
			failClosed: false,
		}),
	).toBe(false);
});

it("finds an executing assignment after a queued match across generated runs", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.constantFrom("queued", "completed", "in_progress", "waiting"),
				{ maxLength: 8 },
			),
			fc.boolean(),
			async (statuses, preferAll) => {
				const otherStatuses = [...statuses, "in_progress"];
				const fake = {
					async request(_installationId: number, path: string) {
						if (path.includes("/runs/9/jobs"))
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
								workflow_runs: otherStatuses.map((_, index) => ({
									id: index + 10,
								})),
							});
						for (let index = 0; index < otherStatuses.length; index++) {
							if (path.includes(`/runs/${index + 10}/jobs`))
								return Response.json({
									jobs: [
										{
											id: index + 2,
											run_id: index + 10,
											status: otherStatuses[index],
											runner_id: 42,
											runner_name: "hobo-runner",
										},
									],
								});
						}
						throw new Error(`unexpected GitHub request ${path}`);
					},
				};
				const preferred = preferAll
					? [9, ...otherStatuses.map((_, index) => index + 10)]
					: [9];
				const result = await resolveRunnerAssignedJob(
					fake,
					1,
					"org/repo",
					"hobo-runner",
					42,
					{ reservedJobId: 1, preferRunIds: preferred },
				);
				expect(result).toBeDefined();
				if (!result) throw new Error("missing assignment");
				expect(RUNNER_EXECUTING_JOB_STATUSES.has(result.status)).toBe(true);
			},
		),
		{ seed: 614468, numRuns: 100 },
	);
});
