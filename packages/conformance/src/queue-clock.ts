import {
	type ClockReplayResult,
	type ClockTraceEntry,
	NondeterministicClockError,
	parseIdempotencyKey,
	parseQueueName,
	parseRunId,
	parseScheduleId,
	QUEUE_CLOCK_RUNTIME_PORT_CONTRACT_VERSION,
	type Queue,
	type VirtualClock,
} from "@hobo/core";
import type { JsonValue } from "./json.js";

export const QUEUE_CLOCK_CONFORMANCE_CONTRACT =
	QUEUE_CLOCK_RUNTIME_PORT_CONTRACT_VERSION;

export type QueueClockAssertionName =
	| "queueIdempotencyKeyDedup"
	| "atLeastOnceRetry"
	| "redeliveryDedup"
	| "durableTimerRestart"
	| "durableCronRestart"
	| "seededClockReplay";

export type QueueClockConformanceReport = {
	readonly contract: typeof QUEUE_CLOCK_CONFORMANCE_CONTRACT;
	readonly backend: string;
	readonly assertions: Record<QueueClockAssertionName, "pass" | "fail">;
};

export type CreateRuntimeLocalQueueClock = (options?: {
	seed?: string;
	startInstant?: string;
	snapshot?: JsonValue;
}) => {
	queue: Queue;
	clock: VirtualClock;
	snapshot(): JsonValue;
};

export type ReplayClockTraceFn = (
	trace: readonly ClockTraceEntry[],
	options?: { seed?: string },
) => ClockReplayResult;

export type QueueClockConformanceOptions = {
	backend?: string;
	replayClockTrace: ReplayClockTraceFn;
};

export async function runQueueClockConformance(
	createRuntime: CreateRuntimeLocalQueueClock,
	options: QueueClockConformanceOptions,
): Promise<QueueClockConformanceReport> {
	if (!(createRuntime instanceof Function)) {
		throw new TypeError("createRuntime must be a function");
	}

	// SAFETY: assertion to `{} as Record<QueueClockAssertionName, "pass" | "fail">` is required at this boundary.
	const assertions = {} as Record<QueueClockAssertionName, "pass" | "fail">;

	const runAssertion = async (
		name: QueueClockAssertionName,
		fn: () => boolean | Promise<boolean>,
	) => {
		try {
			assertions[name] = (await fn()) ? "pass" : "fail";
		} catch {
			assertions[name] = "fail";
		}
	};

	await runAssertion("queueIdempotencyKeyDedup", () =>
		provesQueueIdempotencyKeyDedup(createRuntime),
	);
	await runAssertion("atLeastOnceRetry", () =>
		provesAtLeastOnceRetry(createRuntime),
	);
	await runAssertion("redeliveryDedup", () =>
		provesRedeliveryDedup(createRuntime),
	);
	await runAssertion("durableTimerRestart", () =>
		provesDurableTimerRestart(createRuntime),
	);
	await runAssertion("durableCronRestart", () =>
		provesDurableCronRestart(createRuntime),
	);
	await runAssertion("seededClockReplay", () =>
		provesSeededClockReplay(createRuntime, options.replayClockTrace),
	);

	return {
		contract: QUEUE_CLOCK_CONFORMANCE_CONTRACT,
		backend: options.backend ?? "runtime-local",
		assertions,
	};
}

async function provesQueueIdempotencyKeyDedup(
	createRuntime: CreateRuntimeLocalQueueClock,
): Promise<boolean> {
	const runtime = createRuntime();
	const queue = parseQueueName("jobs");
	const key = parseIdempotencyKey("job-1");
	const first = await runtime.queue.enqueue(
		queue,
		{ name: "send" },
		{ idempotencyKey: key },
	);
	const retry = await runtime.queue.enqueue(
		queue,
		{ name: "send" },
		{ idempotencyKey: key },
	);
	return retry.deduped === true && retry.messageId === first.messageId;
}

async function provesAtLeastOnceRetry(
	createRuntime: CreateRuntimeLocalQueueClock,
): Promise<boolean> {
	const runtime = createRuntime();
	const queue = parseQueueName("jobs");
	const key = parseIdempotencyKey("job-1");
	await runtime.queue.enqueue(
		queue,
		{ name: "retry" },
		{ idempotencyKey: key },
	);
	let attempts = 0;
	try {
		await runtime.queue.handle(queue, async () => {
			attempts += 1;
			throw new Error("transient");
		});
	} catch {
		// Expected retry path.
	}
	await runtime.queue.handle(queue, async () => {
		attempts += 1;
	});
	return attempts === 2;
}

async function provesRedeliveryDedup(
	createRuntime: CreateRuntimeLocalQueueClock,
): Promise<boolean> {
	const runtime = createRuntime();
	const queue = parseQueueName("jobs");
	const key = parseIdempotencyKey("job-1");
	const enqueued = await runtime.queue.enqueue(
		queue,
		{ name: "once" },
		{ idempotencyKey: key },
	);
	const effects: string[] = [];
	await runtime.queue.handle(queue, async (message) => {
		effects.push(message.idempotencyKey);
	});
	runtime.queue.simulateRedelivery(enqueued.messageId);
	await runtime.queue.handle(queue, async (message) => {
		effects.push(message.idempotencyKey);
	});
	return effects.length === 1;
}

function provesDurableTimerRestart(
	createRuntime: CreateRuntimeLocalQueueClock,
): boolean {
	const runtime = createRuntime({
		seed: "timer-restart",
		startInstant: "2026-06-26T00:00:00.000Z",
	});
	const timer = runtime.clock.sleep(parseRunId("run-1"), 1_000, {
		idempotencyKey: "sleep-1",
	});
	const restarted = createRuntime({ snapshot: runtime.snapshot() });
	const fired = restarted.clock.advance(1_000);
	const restartedAgain = createRuntime({ snapshot: restarted.snapshot() });
	return (
		fired.length === 1 &&
		fired[0]?.timerId === timer.timerId &&
		restarted.clock.advance(0).length === 0 &&
		restartedAgain.clock.advance(1_000).length === 0
	);
}

function provesDurableCronRestart(
	createRuntime: CreateRuntimeLocalQueueClock,
): boolean {
	const runtime = createRuntime({
		seed: "cron-restart",
		startInstant: "2026-06-26T00:00:00.000Z",
	});
	runtime.clock.cron(parseScheduleId("heartbeat"), { everyMs: 1_000 });
	const restarted = createRuntime({ snapshot: runtime.snapshot() });
	const fired = restarted.clock.advance(1_000);
	const restartedAgain = createRuntime({ snapshot: restarted.snapshot() });
	return (
		fired.length === 1 &&
		fired[0]?.fireId === "cron:heartbeat:1" &&
		restartedAgain.clock.advance(0).length === 0
	);
}

function provesSeededClockReplay(
	createRuntime: CreateRuntimeLocalQueueClock,
	replayClockTrace: ReplayClockTraceFn,
): boolean {
	const runtime = createRuntime({
		seed: "seeded",
		startInstant: "2026-06-26T00:00:00.000Z",
	});
	runtime.clock.sleep(parseRunId("slow"), 30, { idempotencyKey: "slow" });
	runtime.clock.sleep(parseRunId("fast"), 10, { idempotencyKey: "fast" });
	runtime.clock.advance(10);
	runtime.clock.advance(20);
	try {
		const replay = replayClockTrace(runtime.clock.trace(), { seed: "seeded" });
		return replay.fireOrder.join(",") === "timer:timer-2,timer:timer-1";
	} catch (error) {
		if (error instanceof NondeterministicClockError) {
			return false;
		}
		throw error;
	}
}
