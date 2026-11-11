import type { GithubTransport, GithubRunWorkflowJob } from "./github.js";
import {
	listInProgressWorkflowRunIds,
	listRunWorkflowJobs,
} from "./github.js";

/** GitHub job statuses that keep a JIT runner registered and busy. */
export const RUNNER_HELD_JOB_STATUSES = new Set([
	"queued",
	"in_progress",
	"waiting",
	"pending",
	"requested",
]);

export type ResolvedRunnerAssignment = Readonly<{
	jobId: number;
	runId: number;
	status: string;
}>;

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

function servedOnRun(
	jobs: readonly GithubRunWorkflowJob[],
	reservedJobId: number,
	runnerName: string,
	runnerId: number,
): ResolvedRunnerAssignment | undefined {
	const correlation = correlateRunnerOnRun(
		jobs,
		reservedJobId,
		runnerName,
		runnerId,
	);
	if (correlation.kind === "unassigned") return undefined;
	const job = jobs.find((candidate) => candidate.id === correlation.jobId);
	if (!job) return undefined;
	return { jobId: job.id, runId: job.run_id, status: correlation.status };
}

export function runnerHoldsActiveJob(
	assignment: ResolvedRunnerAssignment | undefined,
): boolean {
	return !!assignment && RUNNER_HELD_JOB_STATUSES.has(assignment.status);
}

/**
 * Resolve which workflow job GitHub assigned to a box JIT runner, including when
 * the job is on another workflow run than the lease's reserved job.
 */
export async function resolveRunnerAssignedJob(
	api: GithubTransport,
	installationId: number,
	repository: string,
	runnerName: string,
	runnerId: number,
	options?: Readonly<{
		reservedJobId?: number;
		preferRunIds?: readonly number[];
		inProgressRunLimit?: number;
	}>,
): Promise<ResolvedRunnerAssignment | undefined> {
	const reservedJobId = options?.reservedJobId ?? 0;
	const seenRuns = new Set<number>();
	const scanRun = async (
		runId: number,
	): Promise<ResolvedRunnerAssignment | undefined> => {
		if (seenRuns.has(runId)) return undefined;
		seenRuns.add(runId);
		const jobs = await listRunWorkflowJobs(
			api,
			installationId,
			repository,
			runId,
		);
		return servedOnRun(jobs, reservedJobId, runnerName, runnerId);
	};
	for (const runId of options?.preferRunIds ?? []) {
		const hit = await scanRun(runId);
		if (hit && RUNNER_HELD_JOB_STATUSES.has(hit.status)) return hit;
	}
	const runIds = await listInProgressWorkflowRunIds(
		api,
		installationId,
		repository,
		options?.inProgressRunLimit ?? 25,
	);
	let inactive: ResolvedRunnerAssignment | undefined;
	for (const runId of runIds) {
		const hit = await scanRun(runId);
		if (!hit) continue;
		if (RUNNER_HELD_JOB_STATUSES.has(hit.status)) return hit;
		inactive ??= hit;
	}
	return inactive;
}
