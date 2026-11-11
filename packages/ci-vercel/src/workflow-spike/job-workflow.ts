// SPIKE (throwaway): one CI job lifecycle held as one durable Workflow SDK run.
// Nothing in the relay imports this module; see ./README.md for the findings.
import { createHook, getStepMetadata, RetryableError, sleep } from "workflow";

export interface SpikeJob {
	readonly repo: string;
	readonly jobId: number;
	readonly attempt: number;
}

export type JobAction = "queued" | "in_progress" | "completed";

/** A `workflow_job` webhook, forwarded by the relay with `resumeHook()`. */
export interface JobDelivery {
	/** GitHub's `X-GitHub-Delivery`; redeliveries reuse it. */
	readonly deliveryId: string;
	readonly action: JobAction;
	readonly conclusion?: string;
}

/** Phase deadlines in milliseconds, each held as one durable `sleep()`. */
export interface JobDeadlines {
	readonly pickup: number;
	readonly run: number;
}

export type JobOutcome =
	| { readonly kind: "duplicate"; readonly ownerRunId: string }
	| {
			readonly kind: "completed" | "timed_out";
			readonly conclusion: string;
			readonly accepted: readonly string[];
			readonly duplicatesDropped: number;
			readonly dispatchAttempt: number;
	  };

export function jobToken(job: SpikeJob): string {
	return `job:${job.repo}:${job.jobId}:${job.attempt}`;
}

const rank = {
	queued: 0,
	in_progress: 1,
	completed: 2,
} as const satisfies Record<JobAction, number>;

export async function jobWorkflow(
	job: SpikeJob,
	deadlines: JobDeadlines,
): Promise<JobOutcome> {
	"use workflow";

	// Claim the job's token before any step runs. On workflow@5.2.x this is
	// the documented in-run idempotency pattern; start({ experimental_hook })
	// (atomic, duplicate never becomes a run) needs workflow >= 5.4.0.
	const deliveries = createHook<JobDelivery>({ token: jobToken(job) });
	const owner = await deliveries.getConflict();
	if (owner) return { kind: "duplicate", ownerRunId: owner.runId };

	const jit = await createJitConfig(job);
	const dispatchAttempt = await dispatchRunner(job, jit.runnerName);

	// In-run dedupe: resumeHook() is at-least-once (a retried call appends a
	// second hook_received), and GitHub redelivers webhooks. Replay feeds the
	// same events in the same order, so this list is deterministic.
	const accepted: string[] = [];
	let duplicatesDropped = 0;
	const iterator = deliveries[Symbol.asyncIterator]();
	let pending = iterator.next();

	async function awaitAction(
		want: JobAction,
		deadline: number,
	): Promise<JobDelivery | "timeout"> {
		// One durable timer per phase (2 events), raced against every delivery.
		const timer = sleep(deadline).then(() => "timeout" as const);
		for (;;) {
			const next = await Promise.race([pending, timer]);
			if (next === "timeout") return next;
			pending = iterator.next();
			if (next.done) return "timeout";
			const delivery = next.value;
			if (accepted.includes(delivery.deliveryId)) {
				duplicatesDropped++;
				continue;
			}
			accepted.push(delivery.deliveryId);
			if (rank[delivery.action] >= rank[want]) return delivery;
		}
	}

	const finish = async (
		kind: "completed" | "timed_out",
		conclusion: string,
	): Promise<JobOutcome> => {
		await settleJob(job, conclusion);
		return { kind, conclusion, accepted, duplicatesDropped, dispatchAttempt };
	};

	const picked = await awaitAction("in_progress", deadlines.pickup);
	if (picked === "timeout") return finish("timed_out", "pickup_timeout");
	const done =
		picked.action === "completed"
			? picked
			: await awaitAction("completed", deadlines.run);
	if (done === "timeout") return finish("timed_out", "run_timeout");
	return finish("completed", done.conclusion ?? "unknown");
}

/**
 * Test seam for the spike only. Steps run in the host process (the Vitest
 * plugin runs them in-process), so a test can gate or fail them through a
 * global without vi.mock(), which does not reach bundled step code.
 */
interface SpikeProbe {
	dispatchFailures?: number;
	dispatchGate?: Promise<void>;
	calls: string[];
}

function probe(): SpikeProbe | undefined {
	// SAFETY: only the spike's tests write this optional global, with this shape.
	return (globalThis as { __workflowSpikeProbe?: SpikeProbe })
		.__workflowSpikeProbe;
}

async function createJitConfig(job: SpikeJob): Promise<{ runnerName: string }> {
	"use step";
	probe()?.calls.push(`jit:${job.jobId}`);
	return { runnerName: `hobo-${job.jobId}-${job.attempt}` };
}

async function dispatchRunner(
	job: SpikeJob,
	runnerName: string,
): Promise<number> {
	"use step";
	const { attempt } = getStepMetadata();
	const spike = probe();
	spike?.calls.push(`dispatch:${job.jobId}:${runnerName}:attempt-${attempt}`);
	if (attempt <= (spike?.dispatchFailures ?? 0)) {
		throw new RetryableError("sandbox capacity busy", { retryAfter: 50 });
	}
	await spike?.dispatchGate;
	return attempt;
}

async function settleJob(job: SpikeJob, conclusion: string): Promise<void> {
	"use step";
	probe()?.calls.push(`settle:${job.jobId}:${conclusion}`);
}

/** A run that does work before it opens its hook: pre-registration resumes. */
export async function lateHookWorkflow(token: string): Promise<JobDelivery[]> {
	"use workflow";
	await holdBeforeHook(token);
	const hook = createHook<JobDelivery>({ token });
	const received: JobDelivery[] = [];
	for await (const delivery of hook) {
		received.push(delivery);
		if (delivery.action === "completed") break;
	}
	return received;
}

async function holdBeforeHook(token: string): Promise<void> {
	"use step";
	probe()?.calls.push(`hold:${token}`);
	await probe()?.dispatchGate;
}

/** Releases its token by ending; used to test token reuse after the run. */
export async function shortHookWorkflow(
	token: string,
	retainMs?: number,
): Promise<string> {
	"use workflow";
	const hook = createHook<JobDelivery>(
		retainMs === undefined
			? { token }
			: { token, experimental_minRetention: retainMs },
	);
	const owner = await hook.getConflict();
	if (owner) return `duplicate:${owner.runId}`;
	const first = await hook;
	return first.deliveryId;
}
