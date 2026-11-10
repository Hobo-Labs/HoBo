import { describe, expect, it } from "vitest";
import { correlateRunnerOnRun } from "../src/jit-runner-correlation.js";

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
});
