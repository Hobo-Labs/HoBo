import type { Pool } from "pg";

import { createInMemoryActorHost } from "../../../actor-host-runtime-port-contract/src/actor-host-runtime-port.js";
import { type JsonValue, type JsonObject } from "../json.js";


export function createPostgresActorHost(
  pool: Pool,
  options: { leaseTtlMs?: number; nowMs?: () => number } = {},
) {
  const inner = createInMemoryActorHost({
    leaseTtlMs: options.leaseTtlMs,
    clock: options.nowMs
      ? {
          now: () => new Date(options.nowMs!()).toISOString(),
          nowMs: options.nowMs,
          advance(deltaMs: number) {
            return new Date(options.nowMs!() + deltaMs).toISOString();
          },
        }
      : undefined,
  });

  return Object.freeze({
    acquire(key: string, request: { holderId: string }) {
      const lease = inner.acquire(key, request);
      void pool.query(
        `INSERT INTO hobo_actor_leases (actor_key, holder_id, fence_token, expires_at_ms, released)
         VALUES ($1, $2, $3, $4, FALSE)
         ON CONFLICT (actor_key) DO UPDATE
         SET holder_id = EXCLUDED.holder_id,
             fence_token = EXCLUDED.fence_token,
             expires_at_ms = EXCLUDED.expires_at_ms,
             released = FALSE`,
        [key, request.holderId, lease.fenceToken.toString(), Date.parse(lease.expiresAt)],
      );
      return lease;
    },

    state(key: string, request: { initialState: JsonValue; fold: (state: JsonValue, event: JsonValue) => JsonValue }) {
      const innerState = inner.state(key, request);
      return Object.freeze({
        append(lease: { fenceToken?: bigint }, event: JsonObject) {
          const result = innerState.append(lease, event);
          void pool.query(
            `INSERT INTO hobo_actor_events (actor_key, seq, fence_token, event)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [key, result.seq, lease.fenceToken?.toString() ?? null, JSON.stringify(event)],
          );
          return result;
        },
        read() {
          return innerState.read();
        },
        passivate() {
          return innerState.passivate();
        },
      });
    },
  });
}
