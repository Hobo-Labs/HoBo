import {
	type ClockTraceEntry,
	type FiredTimer,
	NondeterministicClockError,
	parseRunId,
	parseScheduleId,
} from "@hobo/core";

import type {
	CreateRuntimeLocalQueueClock,
	ReplayClockTraceFn,
} from "../../src/queue-clock.js";

export interface TimeTravelReplayResult {
	liveFires: readonly FiredTimer[];
	replayFireOrder: readonly string[];
	replayMatchesLive: boolean;
}

/**
 * Conformance fixture: seeded live run interleaving sleep + cron under advance(),
 * trace replayed via replayClockTrace reproduces identical fire order.
 */
export function runTimeTravelReplay(
	createRuntime: CreateRuntimeLocalQueueClock,
	replayClockTrace: ReplayClockTraceFn,
): TimeTravelReplayResult {
	const seed = "time-travel-seed";
	const runtime = createRuntime({
		seed,
		startInstant: "2026-06-26T00:00:00.000Z",
	});

	runtime.clock.sleep(parseRunId("run:slow"), 30, {
		idempotencyKey: "sleep-slow",
	});
	runtime.clock.sleep(parseRunId("run:fast"), 10, {
		idempotencyKey: "sleep-fast",
	});
	runtime.clock.cron(parseScheduleId("heartbeat"), { everyMs: 50 });
	const firstAdvance = runtime.clock.advance(10);
	const secondAdvance = runtime.clock.advance(40);
	const liveFires = [...firstAdvance, ...secondAdvance];
	const trace = runtime.clock.trace();

	const replay = replayClockTrace(trace, { seed });
	const liveFireIds = liveFires.map((fire) => fire.fireId);

	return {
		liveFires,
		replayFireOrder: replay.fireOrder,
		replayMatchesLive: replay.fireOrder.join(",") === liveFireIds.join(","),
	};
}

export function assertSeedMismatchRejects(
	trace: readonly ClockTraceEntry[],
	replayClockTrace: ReplayClockTraceFn,
): boolean {
	try {
		replayClockTrace(trace, { seed: "wrong-seed" });
		return false;
	} catch (error) {
		return error instanceof NondeterministicClockError;
	}
}

export function assertMutatedFireFactRejects(
	trace: readonly ClockTraceEntry[],
	replayClockTrace: ReplayClockTraceFn,
): boolean {
	const tampered = trace.map((entry) =>
		entry.type === "timer.fired" ? { ...entry, atMs: entry.atMs + 1 } : entry,
	);
	try {
		const seed = trace.find((entry) => entry.type === "clock.started")?.seed;
		replayClockTrace(tampered, { seed });
		return false;
	} catch (error) {
		return error instanceof NondeterministicClockError;
	}
}
