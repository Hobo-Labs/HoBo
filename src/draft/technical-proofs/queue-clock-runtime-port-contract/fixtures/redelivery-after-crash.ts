import type { CreateRuntimeLocalQueueClock } from "../src/types.js";

export interface RedeliveryAfterCrashResult {
  effectCount: number;
  messageCompleted: boolean;
  messageId: string;
}

/**
 * Conformance fixture: enqueue with idempotency key, handler records one effect
 * then crashes before complete, snapshot/restore, message redelivered, effect
 * count stays 1 and message reaches completed.
 *
 * Effect ledger simulates a durable projection keyed by idempotency key (Plan 05
 * exactly-once effects over at-least-once delivery).
 */
export async function runRedeliveryAfterCrash(
  createRuntime: CreateRuntimeLocalQueueClock,
): Promise<RedeliveryAfterCrashResult> {
  const effectLedger = new Set<string>();
  const recordEffect = (idempotencyKey: string) => {
    effectLedger.add(idempotencyKey);
  };

  const runtime = createRuntime({ seed: "redelivery-crash" });
  const enqueued = await runtime.queue.enqueue(
    "jobs",
    { task: "charge" },
    { idempotencyKey: "job-crash-1" },
  );

  try {
    await runtime.queue.handle("jobs", async (message) => {
      recordEffect(message.idempotencyKey);
      throw new Error("crash before complete");
    });
  } catch {
    // Simulated worker crash before complete().
  }

  const restored = createRuntime({ snapshot: runtime.snapshot() });
  const redelivery = await restored.queue.handle("jobs", async (message) => {
    recordEffect(message.idempotencyKey);
  });

  return {
    effectCount: effectLedger.size,
    messageCompleted: redelivery.handled.includes(enqueued.messageId),
    messageId: enqueued.messageId,
  };
}
