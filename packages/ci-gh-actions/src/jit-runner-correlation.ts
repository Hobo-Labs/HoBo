import type { GithubRunWorkflowJob } from "./github.js";

export type RunnerRunCorrelation = Readonly<
	| { kind: "unassigned" }
	| { kind: "served-reserved"; jobId: number; status: string }
	| { kind: "served-other"; jobId: number; status: string }
>;

function runnerMatchesJob(
	job: GithubRunWorkflowJob,
	runnerName: string,
	runnerId: number,
): boolean {
	if (runnerId > 0 && job.runner_id === runnerId) return true;
	const name = job.runner_name?.trim();
	return name !== undefined && name !== "" && name === runnerName.trim();
}

/** Which workflow job on this run GitHub bound to an ephemeral box JIT runner. */
export function correlateRunnerOnRun(
	jobs: readonly GithubRunWorkflowJob[],
	reservedJobId: number,
	runnerName: string,
	runnerId: number,
): RunnerRunCorrelation {
	const served = jobs.filter((job) =>
		runnerMatchesJob(job, runnerName, runnerId),
	);
	if (served.length === 0) return { kind: "unassigned" };
	const reserved = served.find((job) => job.id === reservedJobId);
	if (reserved) {
		return {
			kind: "served-reserved",
			jobId: reserved.id,
			status: reserved.status,
		};
	}
	const other = served[0];
	if (!other) return { kind: "unassigned" };
	return { kind: "served-other", jobId: other.id, status: other.status };
}
