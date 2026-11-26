export const RUNTIME_POSTGRES_PORTS_VERSION = "hobo.runtime-postgres-ports/v1";

import { createManualClock as createEventStoreClock } from "../../camp-eventstore-runtime-port-contract/src/camp-eventstore-runtime-port.js";
import { createPostgresActorHost } from "./ports/actor-host.js";
import { createPostgresEventStore } from "./ports/event-store.js";
import { createPostgresQueueClock } from "./ports/queue-clock.js";
import { createPostgresStreamer } from "./ports/streamer.js";
import { createPostgresRuntimeSync, type PostgresPoolOptions } from "./postgres/pool.js";

export type PostgresDurabilityBackendOptions = PostgresPoolOptions & {
  seed?: string;
  startInstant?: string;
};

export function createPostgresDurabilityBackend(
  options: PostgresDurabilityBackendOptions = {},
) {
  const runtime = createPostgresRuntimeSync(options);
  const startInstant = options.startInstant ?? "2026-06-26T00:00:00.000Z";
  const clock = createEventStoreClock(startInstant);
  const queueClock = createPostgresQueueClock(runtime.pool, {
    seed: options.seed ?? "runtime-postgres-conformance",
    startInstant,
  });

  return Object.freeze({
    name: "runtime-postgres",
    contract: RUNTIME_POSTGRES_PORTS_VERSION,
    pool: runtime.pool,
    eventStore: createPostgresEventStore(runtime.pool, clock),
    queueClock,
    actorHost: createPostgresActorHost(runtime.pool, {
      nowMs: () => queueClock.clock.nowMs(),
    }),
    streamer: createPostgresStreamer(runtime.pool, { memDb: runtime.memDb }),
  });
}

export function createPostgresDurabilityBackendFactory(
  options: PostgresDurabilityBackendOptions = {},
) {
  return function createBackend() {
    return createPostgresDurabilityBackend(options);
  };
}
