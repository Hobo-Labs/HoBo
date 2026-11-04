import { describe, expect, it, vi } from "vitest";
import {
	type AssignmentLaunch,
	createAssignmentHealth,
} from "../src/isolated-worker/assignment-health.js";

const launch: AssignmentLaunch = {
	repositoryId: 101,
	jobId: 1,
	runId: 900,
	runAttempt: 1,
	labels: ["hobo"],
};

function observation(
	overrides: Partial<{
		status: string;
		updatedAt: string;
		runnerName: string | null;
		runAttempt: number;
		jobId: number;
	}> = {},
) {
	return {
		repositoryId: 101,
		jobId: overrides.jobId ?? 1,
		runId: 900,
		runAttempt: overrides.runAttempt ?? 1,
		status: overrides.status ?? "queued",
		updatedAt: overrides.updatedAt ?? "2026-11-04T12:00:00.000Z",
		runnerName: overrides.runnerName ?? null,
	};
}

describe("assignment health", () => {
	it("backs off exponentially and parks after three unassigned leases until the cap", () => {
		let now = 0;
		const log = vi.fn();
		const health = createAssignmentHealth({
			now: () => now,
			jitter: () => 0.5,
			log,
		});
		health.observe(observation());
		health.unassigned(launch);
		expect(health.canLaunch(launch, 1)).toBe(false);
		now += 30_000;
		expect(health.canLaunch(launch, 1)).toBe(true);

		health.unassigned(launch);
		expect(health.canLaunch(launch, 1)).toBe(false);
		now += 60_000;
		expect(health.canLaunch(launch, 1)).toBe(true);

		health.unassigned(launch);
		now += 299_999;
		expect(health.canLaunch(launch, 1)).toBe(false);
		now += 1;
		expect(health.canLaunch(launch, 1)).toBe(true);
		expect(
			log.mock.calls.filter(
				([event]) => event === "hobo_ci_job_relaunch_backoff",
			),
		).toHaveLength(3);
		expect(
			log.mock.calls.filter(
				([event]) => event === "hobo_ci_job_unassigned_parked",
			),
		).toHaveLength(1);
		expect(log).toHaveBeenCalledWith(
			"hobo_ci_job_relaunch_backoff",
			expect.objectContaining({ attempt: 3, retryAfterMs: 300_000 }),
		);
	});

	it("releases a parked job when GitHub changes its state and resets on assignment", () => {
		let now = 0;
		const health = createAssignmentHealth({
			now: () => now,
			jitter: () => 0.5,
		});
		health.observe(observation());
		for (const delay of [30_000, 60_000, 0]) {
			health.unassigned(launch);
			now += delay;
		}
		expect(health.canLaunch(launch, 1)).toBe(false);
		health.observe(observation({ updatedAt: "2026-11-04T12:01:00.000Z" }));
		expect(health.canLaunch(launch, 1)).toBe(true);

		health.unassigned(launch);
		expect(health.canLaunch(launch, 1)).toBe(false);
		health.observe(
			observation({ status: "in_progress", runnerName: "hobo-assigned" }),
		);
		expect(health.canLaunch(launch, 1)).toBe(true);
	});

	it("pauses each label to one probe during an assignment stall and recovers on assignment", () => {
		let now = 0;
		const log = vi.fn();
		const health = createAssignmentHealth({
			now: () => now,
			jitter: () => 0.5,
			stallAfterMs: 1_000,
			log,
		});
		const second: AssignmentLaunch = { ...launch, jobId: 2 };
		const trunk: AssignmentLaunch = {
			...launch,
			jobId: 3,
			labels: ["hobo-trunk"],
		};
		health.observe(observation());
		health.observe(observation({ jobId: 2 }));
		health.unassigned(launch);
		now += 30_000;

		expect(health.canLaunch(launch, 2)).toBe(true);
		health.noteLaunch(launch, 2);
		expect(health.canLaunch(second, 2)).toBe(false);
		expect(health.canLaunch(trunk, 2)).toBe(true);
		health.noteLaunch(trunk, 2);
		expect(health.canLaunch(second, 2)).toBe(false);
		expect(
			log.mock.calls.filter(
				([event]) => event === "hobo_ci_github_assignment_stall",
			),
		).toHaveLength(1);

		health.observe(
			observation({ status: "in_progress", runnerName: "hobo-assigned" }),
		);
		expect(health.canLaunch(second, 2)).toBe(true);
	});
});
