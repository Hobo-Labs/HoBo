import { servedRunnerLabel } from "../runner-labels.js";

export type AssignmentObservation = Readonly<{
	repositoryId: number;
	jobId: number;
	runId: number;
	runAttempt: number;
	status: string;
	updatedAt: string | undefined;
	runnerName: string | null | undefined;
}>;

export type AssignmentLaunch = Readonly<{
	repositoryId: number;
	jobId: number;
	runId: number;
	runAttempt: number;
	labels: readonly string[];
}>;

export type AssignmentHealthEvent =
	| "hobo_ci_github_assignment_stall"
	| "hobo_ci_job_relaunch_backoff"
	| "hobo_ci_job_unassigned_parked";

export type AssignmentHealthLog = (
	event: AssignmentHealthEvent,
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

type JobBackoff = {
	attempts: number;
	retryAtMs: number;
	signature: string;
	parked: boolean;
};

function keyOf(
	job: Pick<AssignmentLaunch, "repositoryId" | "jobId" | "runAttempt">,
) {
	return `${job.repositoryId}:${job.jobId}:${job.runAttempt}`;
}

function labelOf(job: AssignmentLaunch): string {
	return servedRunnerLabel(job.labels) ?? "unknown";
}

export function createAssignmentHealth(
	options: {
		now?: () => number;
		jitter?: () => number;
		baseBackoffMs?: number;
		maxBackoffMs?: number;
		parkAttempts?: number;
		stallAfterMs?: number;
		log?: AssignmentHealthLog;
	} = {},
) {
	const now = options.now ?? Date.now;
	const jitter = options.jitter ?? Math.random;
	const baseBackoffMs = options.baseBackoffMs ?? 30_000;
	const maxBackoffMs = options.maxBackoffMs ?? 5 * 60_000;
	const parkAttempts = options.parkAttempts ?? 3;
	const stallAfterMs = options.stallAfterMs ?? 2 * 60_000;
	if (
		!Number.isInteger(baseBackoffMs) ||
		baseBackoffMs < 1 ||
		!Number.isInteger(maxBackoffMs) ||
		maxBackoffMs < baseBackoffMs ||
		!Number.isInteger(parkAttempts) ||
		parkAttempts < 1 ||
		!Number.isInteger(stallAfterMs) ||
		stallAfterMs < 1
	)
		throw new Error("invalid assignment health timing");
	const backoffs = new Map<string, JobBackoff>();
	const observations = new Map<string, string>();
	const probes = new Set<string>();
	let lastAssignmentMs = now();
	let stallLogged = false;

	function stalled(queuedJobs: number): boolean {
		return (
			backoffs.size > 0 &&
			queuedJobs >= 2 &&
			now() - lastAssignmentMs >= stallAfterMs
		);
	}

	function observe(job: AssignmentObservation): void {
		const key = keyOf(job);
		if (job.runnerName) {
			backoffs.delete(key);
			observations.delete(key);
			lastAssignmentMs = now();
			stallLogged = false;
			probes.clear();
			return;
		}
		if (job.status === "completed") {
			backoffs.delete(key);
			observations.delete(key);
			return;
		}
		const signature = `${job.status}:${job.updatedAt ?? ""}:${job.runAttempt}`;
		const previousSignature = observations.get(key);
		observations.set(key, signature);
		const current = backoffs.get(key);
		if (
			current?.parked &&
			previousSignature !== undefined &&
			previousSignature !== signature
		) {
			backoffs.delete(key);
			return;
		}
		if (current) current.signature = signature;
	}

	function canLaunch(job: AssignmentLaunch, queuedJobs: number): boolean {
		const current = backoffs.get(keyOf(job));
		if (current && now() < current.retryAtMs) return false;
		if (!stalled(queuedJobs)) return true;
		if (!stallLogged) {
			stallLogged = true;
			options.log?.("hobo_ci_github_assignment_stall", {
				queuedJobs,
				withoutAssignmentMs: now() - lastAssignmentMs,
			});
		}
		return !probes.has(labelOf(job));
	}

	function noteLaunch(job: AssignmentLaunch, queuedJobs: number): void {
		if (stalled(queuedJobs)) probes.add(labelOf(job));
	}

	function unassigned(job: AssignmentLaunch): void {
		const key = keyOf(job);
		const previous = backoffs.get(key);
		const attempts = (previous?.attempts ?? 0) + 1;
		const signature = previous?.signature ?? observations.get(key) ?? "";
		const delayMs = Math.min(
			maxBackoffMs,
			baseBackoffMs * 2 ** Math.min(attempts - 1, 20),
		);
		const random = jitter();
		const factor = 0.75 + Math.min(1, Math.max(0, random)) * 0.5;
		const parked = attempts >= parkAttempts;
		const retryAtMs = parked
			? now() + maxBackoffMs
			: now() + Math.round(delayMs * factor);
		backoffs.set(key, {
			attempts,
			retryAtMs,
			signature,
			parked,
		});
		probes.delete(labelOf(job));
		options.log?.("hobo_ci_job_relaunch_backoff", {
			jobId: job.jobId,
			runId: job.runId,
			attempt: attempts,
			retryAfterMs: Math.max(0, retryAtMs - now()),
			parked,
		});
		if (parked && !previous?.parked)
			options.log?.("hobo_ci_job_unassigned_parked", {
				jobId: job.jobId,
				runId: job.runId,
				attempt: attempts,
				parkUntil: new Date(retryAtMs).toISOString(),
			});
	}

	return { observe, canLaunch, noteLaunch, unassigned };
}

export type AssignmentHealth = ReturnType<typeof createAssignmentHealth>;
