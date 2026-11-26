import type { Pool } from "pg";

import { createRuntimeLocalQueueClock } from "../../../queue-clock-runtime-port-contract/src/queue-clock-runtime-port.js";
import { clone, requireNonEmptyString } from "../postgres/json.js";
import { type JsonValue } from "../json.js";

type LocalQueueClock = ReturnType<typeof createRuntimeLocalQueueClock>;

export function createPostgresQueueClock(
  pool: Pool,
  options: {
    seed?: string;
    startInstant?: string;
  } = {},
) {
  const local = createRuntimeLocalQueueClock({
    seed: options.seed ?? "runtime-postgres-conformance",
    startInstant: options.startInstant ?? "2026-06-26T00:00:00.000Z",
  });

  return Object.freeze({
    queue: createPostgresQueuePort(pool, local),
    clock: local.clock,
    snapshot() {
      return clone({
        queue: "postgres",
        clock: local.snapshot(),
      });
    },
  });
}

function createPostgresQueuePort(pool: Pool, local: LocalQueueClock) {
  return Object.freeze({
    async enqueue(queueName: string, body: JsonValue, options: { idempotencyKey: string }) {
      const name = requireNonEmptyString(queueName, "queueName");
      const idempotencyKey = requireNonEmptyString(options.idempotencyKey, "options.idempotencyKey");
      const existing = await pool.query(
        `SELECT message_id, queue_name, idempotency_key, body
         FROM hobo_queue_messages
         WHERE queue_name = $1 AND idempotency_key = $2`,
        [name, idempotencyKey],
      );
      if (existing.rows[0]) {
        return {
          messageId: existing.rows[0].message_id,
          queueName: existing.rows[0].queue_name,
          idempotencyKey: existing.rows[0].idempotency_key,
          body: existing.rows[0].body,
          deduped: true,
        };
      }

      const localResult = await local.queue.enqueue(name, body, { idempotencyKey });
      await pool.query(
        `INSERT INTO hobo_queue_messages (
           message_id, queue_name, idempotency_key, body, state,
           available_at_ms, delivery_attempt, processing
         ) VALUES ($1, $2, $3, $4::jsonb, 'pending', $5, 0, FALSE)`,
        [
          localResult.messageId,
          name,
          idempotencyKey,
          JSON.stringify(body),
          local.clock.nowMs(),
        ],
      );
      return localResult;
    },

    async handle(queueName: string, handler: (message: JsonValue) => Promise<void> | void, options = {}) {
      return local.queue.handle(queueName, handler, options);
    },

    async dequeue(queueName: string, options = {}) {
      return local.queue.dequeue(queueName, options);
    },

    async complete(messageId: string, leaseId: string) {
      await pool.query(
        `UPDATE hobo_queue_messages
         SET state = 'completed', completed_at_ms = $2, processing = FALSE
         WHERE message_id = $1`,
        [messageId, local.clock.nowMs()],
      );
      return local.queue.complete(messageId, leaseId);
    },

    release(messageId: string, leaseId: string) {
      return local.queue.release(messageId, leaseId);
    },

    simulateRedelivery(messageId: string) {
      void pool.query(
        `UPDATE hobo_queue_messages
         SET state = 'pending', lease_id = NULL, lease_expires_at_ms = NULL, processing = FALSE
         WHERE message_id = $1`,
        [messageId],
      );
      return local.queue.simulateRedelivery(messageId);
    },

    async signal(actorKey: string, msg: JsonValue, options: { idempotencyKey: string }) {
      return local.queue.signal(actorKey, msg, options);
    },
  });
}
