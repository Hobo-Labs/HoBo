import type { RunnerRetryPolicy } from "../_generated/runner_route_pb.js";
import { RUNNER_RETRY_TARGETS, type RunnerRetryTarget } from "./order.js";

export const RUNNER_RETRY_KINDS = [
	"runner_start",

	"machine_lost",

	"runner_lost",
] as const;
export type RunnerRetryKind = (typeof RUNNER_RETRY_KINDS)[number];

// public-contract: slack after a job's end in which a machine disconnect still explains its failure.
export const MACHINE_DISCONNECT_SLACK_MS = 2 * 60_000;
// public-contract: automatic retries one account may spend in a day.
export const RUNNER_RETRY_DAILY_CAP = 100;

export const RUNNER_LOST_PATTERNS: readonly RegExp[] = [
	/lost communication with the server/iu,
	/received a shutdown signal/iu,
];

export type FailedJob = Readonly<{
	ranSteps: boolean;
	startedAtMs: number | undefined;
	completedAtMs: number | undefined;
	annotations: readonly string[];
	machineDisconnects: readonly number[];
}>;

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

export function retryVerdict(
	policy: RunnerRetryPolicy,
	failure: Readonly<{
		job: FailedJob;
		relaysInRun: number;
		retriesThisRun: number;
		retriesToday: number;
	}>,
): RetryVerdict {
	if (!policy.enabled) return { retry: false, reason: "off" };
	const target = RUNNER_RETRY_TARGETS.find(
		(candidate) => candidate === policy.runner,
	);
	if (!target) return { retry: false, reason: "off" };
	const kind = retryKind(failure.job);
	if (!kind) return { retry: false, reason: "own_failure" };
	if (failure.relaysInRun !== 1)
		return { retry: false, reason: "several_relays" };
	if (failure.retriesThisRun >= policy.max)
		return { retry: false, reason: "run_limit" };
	if (failure.retriesToday >= RUNNER_RETRY_DAILY_CAP)
		return { retry: false, reason: "daily_limit" };
	return { retry: true, kind, target };
}
