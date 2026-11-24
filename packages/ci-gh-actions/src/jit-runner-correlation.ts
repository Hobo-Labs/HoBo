import type { GithubRunWorkflowJob, GithubTransport } from "./github.js";
import {
	getJob,
	IncompleteGithubRunListing,
	listInProgressWorkflowRunIds,
	listRunWorkflowJobs,
} from "./github.js";
import { ISOLATED_JIT_QUEUED_BOUND_GRACE_MS } from "./isolated-worker/container-timeout.js";

export const RUNNER_HELD_JOB_STATUSES = new Set([
	"queued",
	"in_progress",
	"waiting",
	"pending",
	"requested",
]);

export const RUNNER_EXECUTING_JOB_STATUSES = new Set([
	"in_progress",
	"waiting",
	"pending",
	"requested",
]);

export function isUnknownRunnerJobStatus(status: string): boolean {
	return status !== "completed" && !RUNNER_HELD_JOB_STATUSES.has(status);
}

export type ResolvedRunnerAssignment = Readonly<{
	jobId: number;
	runId: number;
	status: string;
	incomplete?: true;
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
	return runnerMatchesGitHubJob({ runnerId, runnerName }, job);
}

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
	const executing = served.filter((job) =>
		RUNNER_EXECUTING_JOB_STATUSES.has(job.status),
	);
	const unknown = served.filter((job) => isUnknownRunnerJobStatus(job.status));
	const held = served.filter((job) => RUNNER_HELD_JOB_STATUSES.has(job.status));
	const candidates = executing.length
		? executing
		: unknown.length
			? unknown
			: held.length
				? held
				: served;
	const reserved = candidates.find((job) => job.id === reservedJobId);
	if (reserved) {
		return {
			kind: "served-reserved",
			jobId: reserved.id,
			status: reserved.status,
		};
	}
	const other = candidates[0];
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
	return (
		!!assignment &&
		(RUNNER_HELD_JOB_STATUSES.has(assignment.status) ||
			isUnknownRunnerJobStatus(assignment.status))
	);
}

export function runnerMatchesGitHubJob(
	lease: Readonly<{ runnerId: number; runnerName: string }>,
	job: Readonly<{
		runner_id?: number | null | undefined;
		runner_name?: string | null | undefined;
	}>,
): boolean {
	if (lease.runnerId > 0 && (job.runner_id ?? 0) > 0)
		return job.runner_id === lease.runnerId;
	const name = job.runner_name?.trim();
	return name !== undefined && name !== "" && name === lease.runnerName.trim();
}

export function servedGitHubJobBlocksSettlement(
	lease: Readonly<{ runnerId: number; runnerName: string }>,
	job: Readonly<{
		status: string;
		runner_id?: number | null;
		runner_name?: string | null;
	}>,
): boolean {
	if (
		!RUNNER_EXECUTING_JOB_STATUSES.has(job.status) &&
		!isUnknownRunnerJobStatus(job.status)
	)
		return false;
	return runnerMatchesGitHubJob(lease, job);
}

export function assignmentBlocksRunnerTeardown(
	assignment: ResolvedRunnerAssignment | undefined,
	boundSinceMs: number,
	nowMs: number,
	queuedBoundGraceMs = ISOLATED_JIT_QUEUED_BOUND_GRACE_MS,
): boolean {
	if (!assignment) return false;
	if (
		RUNNER_EXECUTING_JOB_STATUSES.has(assignment.status) ||
		isUnknownRunnerJobStatus(assignment.status)
	)
		return true;
	if (assignment.status === "queued") {
		if (
			!Number.isFinite(boundSinceMs) ||
			!Number.isFinite(nowMs) ||
			!Number.isFinite(queuedBoundGraceMs) ||
			queuedBoundGraceMs < 0
		)
			return true;
		const elapsed = nowMs - boundSinceMs;
		return !Number.isFinite(elapsed) || elapsed < queuedBoundGraceMs;
	}
	return false;
}

export async function evaluateRunnerTeardownGuard(
	api: GithubTransport,
	fields: Readonly<{
		installationId: number;
		repository: string;
		runnerName: string;
		runnerId: number;
		reservedJobId: number;
		servedJobId: number;
		preferRunIds: readonly number[];
		boundSinceMs: number;
		nowMs: number;
	}>,
	opts?: Readonly<{
		failClosed?: boolean;
		queuedBoundGraceMs?: number;
		observeServedJob?: boolean;
	}>,
): Promise<boolean> {
	const grace = opts?.queuedBoundGraceMs ?? ISOLATED_JIT_QUEUED_BOUND_GRACE_MS;
	const observeServedJob = opts?.observeServedJob !== false;
	const leaseRef = {
		runnerId: fields.runnerId,
		runnerName: fields.runnerName,
	};
	try {
		const assignment = await resolveRunnerAssignedJob(
			api,
			fields.installationId,
			fields.repository,
			fields.runnerName,
			fields.runnerId,
			{
				reservedJobId: fields.reservedJobId,
				preferRunIds: fields.preferRunIds,
			},
		);
		if (assignment?.incomplete && opts?.failClosed === true) return true;
		if (
			assignmentBlocksRunnerTeardown(
				assignment,
				fields.boundSinceMs,
				fields.nowMs,
				grace,
			)
		)
			return true;
		if (!observeServedJob) return false;
	} catch {
		if (opts?.failClosed === true) return true;
		if (!observeServedJob) return false;
	}
	try {
		const job = await getJob(
			api,
			fields.installationId,
			fields.repository,
			fields.servedJobId,
		);
		const observed = {
			status: job.status,
			runner_id: job.runner_id ?? null,
			runner_name: job.runner_name ?? null,
		};
		if (servedGitHubJobBlocksSettlement(leaseRef, observed)) return true;
		if (
			observed.status === "queued" &&
			runnerMatchesGitHubJob(leaseRef, observed) &&
			assignmentBlocksRunnerTeardown(
				{ jobId: job.id, runId: job.run_id, status: observed.status },
				fields.boundSinceMs,
				fields.nowMs,
				grace,
			)
		)
			return true;
		return false;
	} catch {
		return opts?.failClosed === true;
	}
}

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
	let unknown: ResolvedRunnerAssignment | undefined;
	let queued: ResolvedRunnerAssignment | undefined;
	let inactive: ResolvedRunnerAssignment | undefined;
	try {
		for (const runId of options?.preferRunIds ?? []) {
			const hit = await scanRun(runId);
			if (hit && RUNNER_EXECUTING_JOB_STATUSES.has(hit.status)) return hit;
			if (hit && isUnknownRunnerJobStatus(hit.status)) unknown ??= hit;
			else if (hit?.status === "queued") queued ??= hit;
		}
		let runIds: readonly number[];
		let incomplete = false;
		try {
			runIds = await listInProgressWorkflowRunIds(
				api,
				installationId,
				repository,
				options?.inProgressRunLimit ?? 25,
			);
		} catch (error) {
			if (!(error instanceof IncompleteGithubRunListing)) throw error;
			runIds = error.runIds;
			incomplete = true;
		}
		for (const runId of runIds) {
			const hit = await scanRun(runId);
			if (!hit) continue;
			if (RUNNER_EXECUTING_JOB_STATUSES.has(hit.status)) return hit;
			if (isUnknownRunnerJobStatus(hit.status)) unknown ??= hit;
			else if (hit.status === "queued") queued ??= hit;
			else inactive ??= hit;
		}
		if (incomplete) throw new Error("GitHub runner assignment scan incomplete");
	} catch (error) {
		if (unknown) return { ...unknown, incomplete: true };
		if (queued) return { ...queued, incomplete: true };
		throw error;
	}
	return unknown ?? queued ?? inactive;
}
