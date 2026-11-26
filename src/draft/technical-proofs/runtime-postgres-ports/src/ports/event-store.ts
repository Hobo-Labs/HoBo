import type { Pool } from "pg";

import {
  OptimisticSequenceConflictError,
} from "../../../camp-eventstore-runtime-port-contract/src/camp-eventstore-runtime-port.js";
import { clone, optionalString, requireNonEmptyString } from "../postgres/json.js";
import { isJsonObject, type JsonValue, type JsonObject } from "../json.js";
import { withTransaction } from "../postgres/pool.js";

type Clock = {
  now(): string;
};

type Subscription = {
  filter: { streamId?: string; type?: string };
  handler: (event: JsonValue) => void;
};

export function createPostgresEventStore(pool: Pool, clock: Clock) {
  const subscriptions = new Set<Subscription>();

  return Object.freeze({
    async append(streamId: string, events: JsonValue[], appendOptions: JsonObject = {}) {
      const id = requireNonEmptyString(streamId, "streamId");
      const inputs = normalizeEventInputs(events);
      const expectedSeq = normalizeSeq(appendOptions.expectedSeq, "appendOptions.expectedSeq");

      return withTransaction(pool, async (query) => {
        await query(
          `INSERT INTO hobo_event_streams (stream_id, current_seq)
           VALUES ($1, 0)
           ON CONFLICT (stream_id) DO NOTHING`,
          [id],
        );

        const streamRow = await query(
          `SELECT current_seq FROM hobo_event_streams WHERE stream_id = $1 FOR UPDATE`,
          [id],
        );
        const currentSeq = Number(streamRow.rows[0]?.current_seq ?? 0);

        const deduped = [];
        const pending = [];
        const pendingByKey = new Map<string, unknown>();
        const pendingDuplicateKeys: string[] = [];

        for (const input of inputs) {
          const idempotencyKey = getIdempotencyKey(input);
          if (idempotencyKey) {
            const existing = await query(
              `SELECT envelope FROM hobo_events
               WHERE stream_id = $1 AND idempotency_key = $2`,
              [id, idempotencyKey],
            );
            if (existing.rows[0]) {
              deduped.push(existing.rows[0].envelope);
              continue;
            }
            if (pendingByKey.has(idempotencyKey)) {
              pendingDuplicateKeys.push(idempotencyKey);
              continue;
            }
          }
          pending.push(input);
          if (idempotencyKey) {
            pendingByKey.set(idempotencyKey, input);
          }
        }

        if (pending.length === 0) {
          return Object.freeze({
            streamId: id,
            appended: [],
            deduped: clone(deduped),
          });
        }

        if (currentSeq !== expectedSeq) {
          throw new OptimisticSequenceConflictError(
            `stale expectedSeq for ${id}: expected ${expectedSeq}, actual ${currentSeq}`,
          );
        }

        const appended = [];
        const appendedByKey = new Map<string, unknown>();
        let seq = currentSeq;

        for (const input of pending) {
          seq += 1;
          const envelope = createEnvelope({
            streamId: id,
            seq,
            input,
            appendOptions,
            clock,
          });
          const idempotencyKey = getIdempotencyKey(input);
          await query(
            `INSERT INTO hobo_events (stream_id, seq, event_id, event_type, envelope, idempotency_key)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
            [id, seq, envelope.id, envelope.type, JSON.stringify(envelope), idempotencyKey ?? null],
          );
          appended.push(envelope);
          if (idempotencyKey) {
            appendedByKey.set(idempotencyKey, envelope);
          }
          publish(subscriptions, envelope);
        }

        await query(`UPDATE hobo_event_streams SET current_seq = $2 WHERE stream_id = $1`, [id, seq]);

        for (const key of pendingDuplicateKeys) {
          deduped.push(appendedByKey.get(key));
        }

        return Object.freeze({
          streamId: id,
          appended: clone(appended),
          deduped: clone(deduped),
        });
      });
    },

    async read(streamId: string, fromSeq = 1) {
      const id = requireNonEmptyString(streamId, "streamId");
      const startSeq = normalizeSeq(fromSeq, "fromSeq");
      const result = await pool.query(
        `SELECT envelope FROM hobo_events
         WHERE stream_id = $1 AND seq >= $2
         ORDER BY seq ASC`,
        [id, startSeq],
      );
      return clone(result.rows.map((row) => row.envelope));
    },

    subscribe(filter: JsonObject, handler: (event: JsonValue) => void) {
      if (!(handler instanceof Function)) {
        throw new TypeError("handler must be a function");
      }
      const subscription = {
        filter: Object.freeze({
          streamId: optionalString(filter.streamId, "filter.streamId"),
          type: optionalString(filter.type, "filter.type"),
        }),
        handler,
      };
      subscriptions.add(subscription);
      return Object.freeze({
        unsubscribe() {
          subscriptions.delete(subscription);
        },
      });
    },

    async snapshot(streamId: string, state: JsonValue, seq: number) {
      const id = requireNonEmptyString(streamId, "streamId");
      const snapshotSeq = normalizeSeq(seq, "seq");
      const streamRow = await pool.query(
        `SELECT current_seq FROM hobo_event_streams WHERE stream_id = $1`,
        [id],
      );
      const currentSeq = Number(streamRow.rows[0]?.current_seq ?? 0);
      if (snapshotSeq > currentSeq) {
        throw new OptimisticSequenceConflictError(
          `snapshot seq ${snapshotSeq} is ahead of ${id}@${currentSeq}`,
        );
      }
      return Object.freeze({
        streamId: id,
        seq: snapshotSeq,
        state: clone(state),
        savedAt: clock.now(),
      });
    },

    async fold(streamId: string, foldOptions: JsonObject = {}) {
      const events = await this.read(streamId);
      const handlers = normalizeHandlers(foldOptions.handlers);
      let state = cloneRequired(foldOptions.initialState, "foldOptions.initialState");
      const quarantined: Array<JsonObject> = [];

      for (const event of events) {
        // SAFETY: assertion to `const typed = event as { type: string; seq: number };` is required at this boundary.
        const typed = event as { type: string; seq: number };
        if (typed.type.endsWith(".Quarantined")) {
          continue;
        }
        const handler = handlers.get(typed.type);
        if (!handler) {
          continue;
        }
        try {
          state = clone(handler(clone(state), clone(event)));
        } catch (cause) {
          quarantined.push({
            offendingSeq: typed.seq,
            quarantineSeq: typed.seq,
            type: `${typed.type.split(".")[0]}.Quarantined`,
            reason: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }

      return Object.freeze({
        streamId,
        seq: events.length,
        state: clone(state),
        quarantined,
      });
    },
  });
}

function createEnvelope({
  streamId,
  seq,
  input,
  appendOptions,
  clock,
}: {
  streamId: string;
  seq: number;
  input: JsonObject;
  appendOptions: JsonObject;
  clock: Clock;
}) {
  const type = requireNonEmptyString(input.type, "event.type");
  // SAFETY: assertion to `const actor = appendOptions.actor as JsonObject;` is required at this boundary.
  const actor = appendOptions.actor as JsonObject;
  return Object.freeze({
    id: `${streamId}:${seq}:${type}`,
    streamId,
    seq,
    type,
    // SAFETY: assertion to `v: normalizeVersion((input.v as number | undefined) ?? 1),` is required at this boundary.
    v: normalizeVersion((input.v as number | undefined) ?? 1),
    ts: clock.now(),
    actor: clone(actor),
    tenant: requireNonEmptyString(appendOptions.tenant, "appendOptions.tenant"),
    causationId: optionalString(appendOptions.causationId, "appendOptions.causationId"),
    correlationId: optionalString(appendOptions.correlationId, "appendOptions.correlationId"),
    // SAFETY: assertion to `data: clone((input.data as unknown) ?? {}),` is required at this boundary.
    data: clone((input.data as unknown) ?? {}),
    // SAFETY: assertion to `meta: Object.freeze(clone((input.meta as JsonObject | undefined) ?? {})),` is required at this boundary.
    meta: Object.freeze(clone((input.meta as JsonObject | undefined) ?? {})),
  });
}

function publish(subscriptions: Set<Subscription>, envelope: JsonValue) {
  for (const subscription of subscriptions) {
    // SAFETY: assertion to `if (matches(subscription.filter, envelope as { streamId: string; type: string })` is required at this boundary.
    if (matches(subscription.filter, envelope as { streamId: string; type: string })) {
      subscription.handler(clone(envelope));
    }
  }
}

function matches(
  filter: { streamId?: string; type?: string },
  envelope: { streamId: string; type: string },
) {
  return (
    (!filter.streamId || filter.streamId === envelope.streamId) &&
    (!filter.type || filter.type === envelope.type)
  );
}

function normalizeHandlers(handlers: JsonValue) {
  if (!handlers || !isJsonObject(handlers)) {
    throw new TypeError("foldOptions.handlers must be an object");
  }
  return new Map(
    // SAFETY: assertion to `Object.entries(handlers as JsonObject).filter(` is required at this boundary.
    Object.entries(handlers as JsonObject).filter(
      ([, handler]) => handler instanceof Function,
    ) as Array<[string, (state: JsonValue, event: JsonValue) => JsonValue]>,
  );
}

function getIdempotencyKey(input: JsonValue) {
  // SAFETY: assertion to `const record = input as { meta?: { idempotencyKey?: string } };` is required at this boundary.
  const record = input as { meta?: { idempotencyKey?: string } };
  const key = record?.meta?.idempotencyKey;
  if (key === undefined) {
    return undefined;
  }
  return requireNonEmptyString(key, "event.meta.idempotencyKey");
}

function normalizeEventInputs(events: JsonValue) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new TypeError("events must be a non-empty array");
  }
  return events.map((event) => {
    if (!event || !isJsonObject(event)) {
      throw new TypeError("event must be an object");
    }
    // SAFETY: assertion to `return event as JsonObject;` is required at this boundary.
    return event as JsonObject;
  });
}

function normalizeVersion(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("event.v must be a positive safe integer");
  }
  return value;
}

function normalizeSeq(value: JsonValue, fieldName: string) {
  // SAFETY: assertion to `if (!Number.isSafeInteger(value) || (value as number) < 0) {` is required at this boundary.
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }
  // SAFETY: assertion to `return value as number;` is required at this boundary.
  return value as number;
}

function cloneRequired(value: JsonValue, fieldName: string) {
  if (value === undefined) {
    throw new TypeError(`${fieldName} is required`);
  }
  return clone(value);
}
