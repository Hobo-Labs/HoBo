/**
 * Whether a routed job that failed should be run again without anyone asking.
 *
 * Only a failure that is not the job's own doing is retried: the runner never
 * got as far as a step, the machine dropped off while the job was on it, or
 * GitHub lost the runner mid-job. A failing test is the job's business and is
 * never retried here, however flaky it looks; that judgement belongs to
 * whoever reads the diagnosis in `../insights/failure-diagnosis.ts`.
 *
 * A retry re-runs the relay job, so the walk happens again and the policy's
 * `runner` decides whether the failed step goes first, last or nowhere
 * special (`retryOrder` in `./order.ts`).
 *
 * Pure functions: no clock, network or store.
 */
import type { RunnerRetryPolicy } from "../_generated/runner_route_pb.js";
import { RUNNER_RETRY_TARGETS, type RunnerRetryTarget } from "./order.js";

export const RUNNER_RETRY_KINDS = [
	/** The job ended before any step of its own started. */
	"runner_start",
	/** The machine it ran on disconnected while it ran. */
	"machine_lost",
	/** GitHub reported losing the runner. */
	"runner_lost",
] as const;
export type RunnerRetryKind = (typeof RUNNER_RETRY_KINDS)[number];

/**
 * A machine that drops off up to this long after the job's recorded end still
 * counts as lost during it: GitHub notices a dead runner late.
 */
// public-contract: slack after a job's end in which a machine disconnect still explains its failure.
export const MACHINE_DISCONNECT_SLACK_MS = 2 * 60_000;
// public-contract: automatic retries one account may spend in a day.
export const RUNNER_RETRY_DAILY_CAP = 100;

/** Annotation texts GitHub writes when it loses a runner mid-job. */
export const RUNNER_LOST_PATTERNS: readonly RegExp[] = [
	/lost communication with the server/iu,
	/received a shutdown signal/iu,
];

export type FailedJob = Readonly<{
	/** A step of the job's own started (anything after GitHub's "Set up job"). */
	ranSteps: boolean;
	startedAtMs: number | undefined;
	completedAtMs: number | undefined;
	/** Annotation messages on the job's check run. */
	annotations: readonly string[];
	/** When the machine it ran on disconnected, if it did. */
	machineDisconnects: readonly number[];
}>;

/** Why the failure was not the job's own doing, or nothing when it may have been. */
export function retryKind(job: FailedJob): RunnerRetryKind | undefined {
	if (!job.ranSteps) return "runner_start";
	const { startedAtMs, completedAtMs } = job;
	if (
		startedAtMs !== undefined &&
		completedAtMs !== undefined &&
		job.machineDisconnects.some(
			(atMs) =>
				atMs >= startedAtMs &&
				atMs <= completedAtMs + MACHINE_DISCONNECT_SLACK_MS,
		)
	)
		return "machine_lost";
	return job.annotations.some((text) =>
		RUNNER_LOST_PATTERNS.some((pattern) => pattern.test(text)),
	)
		? "runner_lost"
		: undefined;
}

export type RetryVerdict =
	| Readonly<{ retry: true; kind: RunnerRetryKind; target: RunnerRetryTarget }>
	| Readonly<{
			retry: false;
			reason:
				| "off"
				| "own_failure"
				| "several_relays"
				| "run_limit"
				| "daily_limit";
	  }>;

/**
 * Whether to run the failed job again. A run routed through more than one
 * relay is left alone: re-running one relay would re-run every failed job of
 * the run, including ones this failure says nothing about.
 */
export function retryVerdict(
	policy: RunnerRetryPolicy,
	failure: Readonly<{
		job: FailedJob;
		/** Relay jobs in the run. */
		relaysInRun: number;
		/** Automatic retries this run has already had. */
		retriesThisRun: number;
		/** Automatic retries the account has had today. */
		retriesToday: number;
	}>,
): RetryVerdict {
	if (!policy.enabled) return { retry: false, reason: "off" };
	const kind = retryKind(failure.job);
	if (!kind) return { retry: false, reason: "own_failure" };
	if (failure.relaysInRun !== 1)
		return { retry: false, reason: "several_relays" };
	if (failure.retriesThisRun >= policy.max)
		return { retry: false, reason: "run_limit" };
	if (failure.retriesToday >= RUNNER_RETRY_DAILY_CAP)
		return { retry: false, reason: "daily_limit" };
	const target =
		RUNNER_RETRY_TARGETS.find((candidate) => candidate === policy.runner) ??
		"any";
	return { retry: true, kind, target };
}
