import { create } from "@bufbuild/protobuf";
import { type Job, JobSchema, type Lease } from "@hobo/ci";
import { type GithubTransport, getRun } from "../github.js";
import { TRUNK_RUNNER_LABEL } from "../runner-labels.js";
import {
	isUnlaunchedReservation,
	type UnlaunchedReservationLease,
} from "../unlaunched-reservation-release.js";
import type { PollIngestCoalesce } from "./poll-ingest-coalesce.js";

export type HeldJobPruneReason =
	| "run-cancelled"
	| "run-completed"
	| "run-superseded"
	| "job-cancelled"
	| "job-completed";

export type HeldJobPollWitness = Readonly<{
	terminalRuns: readonly Readonly<{
		repositoryId: number;
		runId: number;
		reason: HeldJobPruneReason;
	}>[];
	terminalJobs: readonly Readonly<{
		repositoryId: number;
		jobId: number;
		runAttempt: number;
		reason: "job-cancelled" | "job-completed";
	}>[];
}>;

export type HeldJobPruneStore = Readonly<{
	pendingJobs(): Promise<readonly Job[]>;
	activeLeases(): Promise<readonly Lease[]>;
	withdrawQueuedJob?(
		job: Job,
		at: string,
		expectedRevision?: number,
	): Promise<boolean | undefined> | boolean;
	configuration(): Promise<
		undefined | Readonly<{ revision: number; configuration: unknown }>
	>;
}>;

export type HeldJobPruneLog = (
	event: "hobo_ci_held_job_pruned",
	fields: Readonly<{
		jobId: number;
		runId: number;
		runAttempt: number;
		repositoryId: number;
		reason: HeldJobPruneReason;
	}>,
) => void;

function jobPruneKey(
	repositoryId: number,
	jobId: number,
	runAttempt: number,
): string {
	return `${repositoryId}:${jobId}:${runAttempt}`;
}

function runPruneKey(repositoryId: number, runId: number): string {
	return `${repositoryId}:${runId}`;
}

function buildWitnessIndex(witness: HeldJobPollWitness) {
	const runs = new Map<string, HeldJobPruneReason>();
	for (const entry of witness.terminalRuns) {
		const key = runPruneKey(entry.repositoryId, entry.runId);
		const prior = runs.get(key);
		if (
			prior === undefined ||
			(prior !== "run-cancelled" && entry.reason === "run-cancelled")
		)
			runs.set(key, entry.reason);
	}
	const jobs = new Map<string, HeldJobPruneReason>();
	for (const entry of witness.terminalJobs) {
		jobs.set(
			jobPruneKey(entry.repositoryId, entry.jobId, entry.runAttempt),
			entry.reason,
		);
	}
	return { runs, jobs };
}

function resolvePruneReason(
	repositoryId: number,
	runId: number,
	jobId: number,
	runAttempt: number,
	index: ReturnType<typeof buildWitnessIndex>,
): HeldJobPruneReason | undefined {
	const jobReason = index.jobs.get(
		jobPruneKey(repositoryId, jobId, runAttempt),
	);
	if (jobReason) return jobReason;
	return index.runs.get(runPruneKey(repositoryId, runId));
}

function jobFromLease(lease: UnlaunchedReservationLease & Lease): Job {
	const labels =
		lease.memoryClass === "trunk" ? [TRUNK_RUNNER_LABEL] : ["hobo"];
	return create(JobSchema, {
		id: lease.jobId,
		runId: lease.originalRunId,
		runAttempt: lease.runAttempt,
		repositoryId: lease.repositoryId,
		installationId: lease.installationId,
		repository: lease.repository,
		labels,
		action: "queued",
		runnerName: "",
		isolatedRequired: true,
		name: lease.jobName ?? "",
		memoryClass: lease.memoryClass,
		memoryMb: lease.memoryMb,
		queueDeadlineAt: "",
	});
}

export type PruneHeldJobsOptions = {
	store: HeldJobPruneStore;
	witness: HeldJobPollWitness;
	at: string;
	coalesce?: PollIngestCoalesce;
	clearTrunkWait?: (job: Pick<Job, "repository" | "id" | "runAttempt">) => void;
	log?: HeldJobPruneLog;
};

/** Drop local demand GitHub has already ended, without touching GitHub. */
export function mergeHeldPruneWitness(
	a: HeldJobPollWitness,
	b: HeldJobPollWitness,
): HeldJobPollWitness {
	const runs = new Map<string, HeldJobPollWitness["terminalRuns"][number]>();
	for (const entry of [...a.terminalRuns, ...b.terminalRuns]) {
		const key = runPruneKey(entry.repositoryId, entry.runId);
		const prior = runs.get(key);
		if (
			prior === undefined ||
			(prior.reason !== "run-cancelled" && entry.reason === "run-cancelled")
		)
			runs.set(key, entry);
	}
	const jobs = new Map<string, HeldJobPollWitness["terminalJobs"][number]>();
	for (const entry of [...a.terminalJobs, ...b.terminalJobs]) {
		jobs.set(
			jobPruneKey(entry.repositoryId, entry.jobId, entry.runAttempt),
			entry,
		);
	}
	return {
		terminalRuns: [...runs.values()],
		terminalJobs: [...jobs.values()],
	};
}

function terminalRunReason(
	conclusion: string | null | undefined,
): HeldJobPruneReason {
	if (conclusion === "cancelled") return "run-cancelled";
	return "run-completed";
}

/** Refresh witness for runs still referenced locally when poll lookback missed them. */
export async function refreshHeldPruneWitnessFromStore(options: {
	store: HeldJobPruneStore;
	github: GithubTransport;
}): Promise<HeldJobPollWitness> {
	const terminalRuns: HeldJobPollWitness["terminalRuns"][number][] = [];
	const seen = new Set<string>();
	const pending = await options.store.pendingJobs();
	const leases = await options.store.activeLeases();
	const targets: Array<{
		installationId: number;
		repository: string;
		repositoryId: number;
		runId: number;
	}> = [];
	for (const job of pending) {
		targets.push({
			installationId: job.installationId,
			repository: job.repository,
			repositoryId: job.repositoryId,
			runId: job.runId,
		});
	}
	for (const lease of leases) {
		if (!isUnlaunchedReservation(lease)) continue;
		targets.push({
			installationId: lease.installationId,
			repository: lease.repository,
			repositoryId: lease.repositoryId,
			runId: lease.originalRunId,
		});
	}
	for (const target of targets) {
		const key = runPruneKey(target.repositoryId, target.runId);
		if (seen.has(key)) continue;
		seen.add(key);
		try {
			const run = await getRun(
				options.github,
				target.installationId,
				target.repository,
				target.runId,
			);
			if (run.status !== "completed") continue;
			terminalRuns.push({
				repositoryId: target.repositoryId,
				runId: target.runId,
				reason: terminalRunReason(run.conclusion),
			});
		} catch {}
	}
	return { terminalRuns, terminalJobs: [] };
}

export async function pruneHeldJobs(
	options: PruneHeldJobsOptions,
): Promise<number> {
	if (
		options.witness.terminalRuns.length === 0 &&
		options.witness.terminalJobs.length === 0
	)
		return 0;
	const index = buildWitnessIndex(options.witness);
	const revision = (await options.store.configuration())?.revision;
	const seen = new Set<string>();
	let pruned = 0;

	async function pruneJob(job: Job, reason: HeldJobPruneReason) {
		const dedupe = jobPruneKey(job.repositoryId, job.id, job.runAttempt);
		if (seen.has(dedupe)) return;
		seen.add(dedupe);
		const changed = await options.store.withdrawQueuedJob?.(
			job,
			options.at,
			revision,
		);
		if (!changed) return;
		options.coalesce?.forget(job.repositoryId, job.id, job.runAttempt);
		options.clearTrunkWait?.(job);
		options.log?.("hobo_ci_held_job_pruned", {
			jobId: job.id,
			runId: job.runId,
			runAttempt: job.runAttempt,
			repositoryId: job.repositoryId,
			reason,
		});
		pruned += 1;
	}

	for (const job of await options.store.pendingJobs()) {
		const reason = resolvePruneReason(
			job.repositoryId,
			job.runId,
			job.id,
			job.runAttempt,
			index,
		);
		if (!reason) continue;
		await pruneJob(job, reason);
	}

	for (const lease of await options.store.activeLeases()) {
		if (!isUnlaunchedReservation(lease)) continue;
		const reason = resolvePruneReason(
			lease.repositoryId,
			lease.originalRunId,
			lease.jobId,
			lease.runAttempt,
			index,
		);
		if (!reason) continue;
		await pruneJob(jobFromLease(lease), reason);
	}

	return pruned;
}

const DEFAULT_PRUNE_INTERVAL_MS = 30_000;

export function createHeldJobPruner(options: {
	store: HeldJobPruneStore;
	coalesce?: PollIngestCoalesce;
	clearTrunkWait?: (job: Pick<Job, "repository" | "id" | "runAttempt">) => void;
	log?: HeldJobPruneLog;
	now?: () => number;
	minIntervalMs?: number;
}) {
	const now = options.now ?? Date.now;
	const minIntervalMs = options.minIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
	let lastWitness: HeldJobPollWitness | undefined;
	let lastPruneMs = 0;

	return {
		observePollWitness(witness: HeldJobPollWitness): void {
			lastWitness = witness;
		},
		async maybePrune(force = false): Promise<number> {
			const nowMs = now();
			if (!force && nowMs - lastPruneMs < minIntervalMs) return 0;
			if (!lastWitness) return 0;
			lastPruneMs = nowMs;
			const at = new Date(nowMs).toISOString();
			const pruneOptions: PruneHeldJobsOptions = {
				store: options.store,
				witness: lastWitness,
				at,
			};
			if (options.coalesce) pruneOptions.coalesce = options.coalesce;
			if (options.clearTrunkWait)
				pruneOptions.clearTrunkWait = options.clearTrunkWait;
			if (options.log) pruneOptions.log = options.log;
			return pruneHeldJobs(pruneOptions);
		},
	};
}

export type HeldJobPruner = ReturnType<typeof createHeldJobPruner>;
