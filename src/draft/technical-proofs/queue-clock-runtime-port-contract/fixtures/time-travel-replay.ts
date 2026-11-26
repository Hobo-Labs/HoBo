import {
  NondeterministicClockError,
  replayClockTrace,
} from "../src/queue-clock-runtime-port.js";
import type { ClockTraceEntry, CreateRuntimeLocalQueueClock, FiredTimer } from "../src/types.js";

export interface TimeTravelReplayResult {
  liveFires: readonly FiredTimer[];
  replayFireOrder: readonly string[];
  replayMatchesLive: boolean;
}

/**
 * Conformance fixture: seeded live run interleaving sleep + cron under advance(),
 * trace replayed via replayClockTrace reproduces identical fire order/timestamps/
 * occurrence numbers/fire ids.
 */
export function runTimeTravelReplay(
  createRuntime: CreateRuntimeLocalQueueClock,
): TimeTravelReplayResult {
  const seed = "time-travel-seed";
  const runtime = createRuntime({ seed, startInstant: "2026-06-26T00:00:00.000Z" });

  runtime.clock.sleep("run:slow", 30, { idempotencyKey: "sleep-slow" });
  runtime.clock.sleep("run:fast", 10, { idempotencyKey: "sleep-fast" });
  runtime.clock.cron("heartbeat", { everyMs: 50 });
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

export function assertSeedMismatchRejects(trace: readonly ClockTraceEntry[]): boolean {
  try {
    replayClockTrace(trace, { seed: "wrong-seed" });
    return false;
  } catch (error) {
    return error instanceof NondeterministicClockError;
  }
}

export function assertMutatedFireFactRejects(trace: readonly ClockTraceEntry[]): boolean {
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
