import fc from "fast-check";
import { expect, it } from "vitest";
import {
	assignmentBlocksRunnerTeardown,
	evaluateRunnerTeardownGuard,
} from "../src/jit-runner-correlation.js";

const queued = { jobId: 2, runId: 9, status: "queued" };
it.each([
	[Number.NaN, 10_000, 100],
	[0, Number.NaN, 100],
	[0, Number.POSITIVE_INFINITY, 100],
	[0, 10_000, Number.NaN],
	[0, 10_000, Number.POSITIVE_INFINITY],
	[0, 10_000, -1],
	[-Number.MAX_VALUE, Number.MAX_VALUE, 100],
])("retains queued assignments when timing input is invalid: %s, %s, %s", (since, now, grace) => {
	expect(assignmentBlocksRunnerTeardown(queued, since, now, grace)).toBe(true);
});
it("allows teardown exactly at the grace boundary", () => {
	expect(assignmentBlocksRunnerTeardown(queued, 1000, 1099, 100)).toBe(true);
	expect(assignmentBlocksRunnerTeardown(queued, 1000, 1100, 100)).toBe(false);
	expect(assignmentBlocksRunnerTeardown(queued, 1000, 1000, 0)).toBe(false);
});
it("uses the same conservative timing rule for a direct served-job lookup", async () => {
	const api = {
		async request(_id: number, path: string) {
			if (path.includes("/actions/runs?"))
				return Response.json({ workflow_runs: [] });
			if (path.includes("/actions/jobs/2"))
				return Response.json({
					id: 2,
					run_id: 9,
					status: "queued",
					labels: [],
					runner_id: 42,
					runner_name: "hobo-runner",
				});
			throw new Error(`unexpected request ${path}`);
		},
	};
	const fields = {
		installationId: 1,
		repository: "org/repo",
		runnerName: "hobo-runner",
		runnerId: 42,
		reservedJobId: 1,
		servedJobId: 2,
		preferRunIds: [],
		boundSinceMs: 0,
		nowMs: 10_000,
	};
	for (const timing of [
		{ boundSinceMs: Number.NaN, nowMs: 10_000, grace: 100 },
		{ boundSinceMs: 0, nowMs: Number.NaN, grace: 100 },
		{ boundSinceMs: 0, nowMs: 10_000, grace: Number.NaN },
		{ boundSinceMs: 0, nowMs: 10_000, grace: -1 },
	])
		for (const failClosed of [true, false])
			expect(
				await evaluateRunnerTeardownGuard(
					api,
					{ ...fields, boundSinceMs: timing.boundSinceMs, nowMs: timing.nowMs },
					{ failClosed, queuedBoundGraceMs: timing.grace },
				),
			).toBe(true);
});
it("applies the grace boundary to generated finite timestamps", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 0, max: 1_000_000 }),
			fc.integer({ min: 0, max: 10_000 }),
			fc.integer({ min: 0, max: 10_000 }),
			(since, elapsed, grace) => {
				expect(
					assignmentBlocksRunnerTeardown(queued, since, since + elapsed, grace),
				).toBe(elapsed < grace);
			},
		),
		{ seed: 614472, numRuns: 200 },
	);
});
