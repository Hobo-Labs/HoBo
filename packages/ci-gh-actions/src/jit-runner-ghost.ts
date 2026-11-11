import { ACTIVE_STATES, type Lease } from "@hobo/ci";
import {
	activeLeaseCoversJob,
	leaseIdFromBoxRunnerName,
	runnerCustody,
} from "./job-runner-custody.js";

export type GithubJobBinding = Readonly<{
	status: string;
	runner_name?: string | null | undefined;
	runner_id?: number | null | undefined;
}>;

export type GhostBindingDecision =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "covered"; leaseId: string }>
	| Readonly<{ kind: "ghost"; runnerName: string; runnerId: number }>;

/** Job already bound to a box JIT runner this worker does not actively host. */
export function decideGhostBoxRunnerBinding(
	job: Readonly<{ repositoryId: number; id: number; runAttempt: number }>,
	githubJob: GithubJobBinding,
	activeLeases: readonly Lease[],
): GhostBindingDecision {
	if (githubJob.status !== "in_progress") return { kind: "none" };
	if (runnerCustody(githubJob.runner_name) !== "box") return { kind: "none" };
	const runnerName = githubJob.runner_name?.trim();
	if (!runnerName) return { kind: "none" };
	const runnerId = githubJob.runner_id ?? 0;
	for (const lease of activeLeases) {
		if (!ACTIVE_STATES.has(lease.state)) continue;
		if (
			activeLeaseCoversJob(
				lease,
				job.repositoryId,
				job.id,
				job.runAttempt,
			)
		)
			return { kind: "covered", leaseId: lease.id };
		if (lease.runnerName === runnerName)
			return { kind: "covered", leaseId: lease.id };
	}
	if (!Number.isInteger(runnerId) || runnerId <= 0) return { kind: "none" };
	if (!leaseIdFromBoxRunnerName(runnerName)) return { kind: "none" };
	return { kind: "ghost", runnerName, runnerId };
}
