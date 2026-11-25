import type { Lease } from "@hobo/ci";
import { type GithubTransport, getJob, getRun } from "../github.js";

export type GithubLeaseFate =
	| { kind: "active" }
	| { kind: "terminal"; reason: string };

/** Whether GitHub no longer expects this worker to run the bound job/run. */
export async function resolveGithubLeaseFate(
	github: GithubTransport,
	lease: Lease,
): Promise<GithubLeaseFate> {
	try {
		const run = await getRun(
			github,
			lease.installationId,
			lease.repository,
			lease.originalRunId,
		);
		if (run.status === "completed") {
			return {
				kind: "terminal",
				reason:
					run.conclusion === "cancelled" ? "run-cancelled" : "run-completed",
			};
		}
		const jobId = lease.actualJobId > 0 ? lease.actualJobId : lease.jobId;
		const job = await getJob(
			github,
			lease.installationId,
			lease.repository,
			jobId,
		);
		if (job.run_id !== lease.originalRunId) {
			return { kind: "terminal", reason: "job-run-mismatch" };
		}
		const attempt = job.run_attempt ?? 1;
		if (attempt !== lease.runAttempt) {
			return { kind: "terminal", reason: "job-attempt-mismatch" };
		}
		if (job.status === "completed") {
			return { kind: "terminal", reason: "job-completed" };
		}
		if (
			lease.runnerName &&
			job.runner_name &&
			job.runner_name !== lease.runnerName &&
			job.status !== "queued"
		) {
			return { kind: "terminal", reason: "runner-reassigned" };
		}
		return { kind: "active" };
	} catch {
		return { kind: "active" };
	}
}

export function leaseHasLiveContainer(
	container: { state: string } | undefined,
): boolean {
	if (!container) return false;
	return container.state === "running" || container.state === "removing";
}
