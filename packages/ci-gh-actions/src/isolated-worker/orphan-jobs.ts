import type { Lease } from "@hobo/ci";
import { type GithubTransport, getJob, getRun } from "../github.js";

export type OrphanJobCandidate = Readonly<{
	repository: string;
	installationId: number;
	runId: number;
	jobId: number;
	runnerId: number;
	runnerName: string;
	detectedAtMs: number;
}>;

export type OrphanJobEvent =
	| "hobo_ci_orphan_job_detected"
	| "hobo_ci_orphan_job_dropped"
	| "hobo_ci_orphan_job_confirmed"
	| "hobo_ci_orphan_runner_delete"
	| "hobo_ci_orphan_run_force_cancel"
	| "hobo_ci_orphan_run_rerun"
	| "hobo_ci_orphan_run_rerun_skipped";

export type OrphanJobLog = (
	event: OrphanJobEvent,
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

type TrackedOrphanJob = Omit<OrphanJobCandidate, "runId"> & {
	runId: number;
	confirmed: boolean;
	runnerDeleteAttempted: boolean;
	runForceCancelled: boolean;
};

const CONFIRMATION_GRACE_MS = 60_000;
const CANDIDATE_EXPIRY_MS = 30 * 60_000;
const MAX_CANDIDATES = 200;

function candidateKey(candidate: OrphanJobCandidate): string {
	return `${candidate.repository}:${candidate.jobId}:${candidate.runnerId}`;
}

function candidateFields(candidate: OrphanJobCandidate) {
	return {
		repository: candidate.repository,
		runId: candidate.runId,
		jobId: candidate.jobId,
		runnerId: candidate.runnerId,
		runnerName: candidate.runnerName,
	};
}

export function orphanJobCandidateForLease(
	lease: Lease,
	detectedAtMs: number,
	observed?: Readonly<{ jobId: number; runId: number }>,
): OrphanJobCandidate | undefined {
	if (lease.runnerId === 0) return undefined;
	const jobId =
		observed?.jobId ??
		(lease.actualJobId > 0 ? lease.actualJobId : lease.jobId);
	const runId =
		observed && observed.runId > 0
			? observed.runId
			: lease.originalRunId;
	return {
		repository: lease.repository,
		installationId: lease.installationId,
		runId,
		jobId,
		runnerId: lease.runnerId,
		runnerName: lease.runnerName,
		detectedAtMs,
	};
}

export function createOrphanJobTracker(options: {
	github: GithubTransport;
	now?: () => number;
	log?: OrphanJobLog;
}) {
	const now = options.now ?? Date.now;
	const candidates = new Map<string, TrackedOrphanJob>();
	const retiredCandidates = new Set<string>();

	function retire(candidate: OrphanJobCandidate): void {
		const key = candidateKey(candidate);
		retiredCandidates.delete(key);
		retiredCandidates.add(key);
		if (retiredCandidates.size <= MAX_CANDIDATES) return;
		const oldest = retiredCandidates.values().next().value;
		if (oldest !== undefined) retiredCandidates.delete(oldest);
	}

	function drop(candidate: TrackedOrphanJob, reason: string): void {
		candidates.delete(candidateKey(candidate));
		retire(candidate);
		options.log?.("hobo_ci_orphan_job_dropped", {
			...candidateFields(candidate),
			reason,
		});
	}

	function enqueue(candidate: OrphanJobCandidate): void {
		const key = candidateKey(candidate);
		if (candidates.has(key) || retiredCandidates.has(key)) return;
		while (candidates.size >= MAX_CANDIDATES) {
			const oldestKey = candidates.keys().next().value;
			if (oldestKey === undefined) break;
			const oldest = candidates.get(oldestKey);
			if (oldest) drop(oldest, "capacity");
			else candidates.delete(oldestKey);
		}
		candidates.set(key, {
			...candidate,
			confirmed: false,
			runnerDeleteAttempted: false,
			runForceCancelled: false,
		});
		options.log?.("hobo_ci_orphan_job_detected", candidateFields(candidate));
	}

	async function release(candidate: TrackedOrphanJob): Promise<void> {
		if (!candidate.runnerDeleteAttempted) {
			const response = await options.github.request(
				candidate.installationId,
				`/repos/${candidate.repository}/actions/runners/${candidate.runnerId}`,
				"DELETE",
			);
			options.log?.("hobo_ci_orphan_runner_delete", {
				...candidateFields(candidate),
				status: response.status,
			});
			if (![204, 404, 422].includes(response.status)) return;
			candidate.runnerDeleteAttempted = true;
		}
		if (!candidate.runForceCancelled) {
			const response = await options.github.request(
				candidate.installationId,
				`/repos/${candidate.repository}/actions/runs/${candidate.runId}/force-cancel`,
				"POST",
			);
			options.log?.("hobo_ci_orphan_run_force_cancel", {
				...candidateFields(candidate),
				status: response.status,
			});
			if (response.status !== 202 && response.status !== 409) return;
			candidate.runForceCancelled = true;
		}
		const run = await getRun(
			options.github,
			candidate.installationId,
			candidate.repository,
			candidate.runId,
		);
		if (run.status !== "completed") return;
		if (run.event !== "pull_request" && run.event !== "push") {
			options.log?.("hobo_ci_orphan_run_rerun_skipped", {
				...candidateFields(candidate),
				runAttempt: run.run_attempt,
				event: run.event,
				message:
					run.event === "merge_group"
						? "pull request needs re-queueing"
						: "event is not rerun automatically",
			});
			candidates.delete(candidateKey(candidate));
			retire(candidate);
			return;
		}
		const response = await options.github.request(
			candidate.installationId,
			`/repos/${candidate.repository}/actions/runs/${candidate.runId}/rerun-failed-jobs`,
			"POST",
		);
		options.log?.("hobo_ci_orphan_run_rerun", {
			...candidateFields(candidate),
			runAttempt: run.run_attempt,
			status: response.status,
		});
		if (response.status === 201) {
			candidates.delete(candidateKey(candidate));
			retire(candidate);
		}
	}

	async function reconcile(): Promise<void> {
		for (const candidate of candidates.values()) {
			try {
				if (now() - candidate.detectedAtMs >= CANDIDATE_EXPIRY_MS) {
					drop(candidate, "expired");
					continue;
				}
				if (!candidate.confirmed) {
					const job = await getJob(
						options.github,
						candidate.installationId,
						candidate.repository,
						candidate.jobId,
					);
					candidate.runId = job.run_id;
					if (job.status === "completed") {
						drop(candidate, "completed");
						continue;
					}
					if (job.status === "queued") {
						drop(candidate, "queued");
						continue;
					}
					if (job.runner_name !== candidate.runnerName) {
						drop(candidate, "runner-mismatch");
						continue;
					}
					if (
						job.status !== "in_progress" ||
						now() - candidate.detectedAtMs < CONFIRMATION_GRACE_MS
					)
						continue;
					candidate.confirmed = true;
					options.log?.(
						"hobo_ci_orphan_job_confirmed",
						candidateFields(candidate),
					);
				}
				await release(candidate);
			} catch {}
		}
	}

	return { enqueue, reconcile };
}

export type OrphanJobTracker = ReturnType<typeof createOrphanJobTracker>;
