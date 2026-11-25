import { createInMemoryActorHost } from "./actor-host-port.js";
import {
  createManualClock as createEventStoreClock,
  createRuntimeLocalEventStore,
} from "./eventstore-port.js";
import { createRuntimeLocalQueueClock } from "./queue-clock-port.js";
import type { RuntimeDurabilityBackend } from "../runtime-port/types.js";

export function createRuntimeLocalDurabilityBackend(): RuntimeDurabilityBackend {
  const queueClock = createRuntimeLocalQueueClock({
    seed: "runtime-port-conformance",
    startInstant: "2026-06-26T00:00:00.000Z",
  });

  return Object.freeze({
    name: "runtime-local",
    eventStore: createRuntimeLocalEventStore({
      clock: createEventStoreClock("2026-06-26T00:00:00.000Z"),
    }),
    queue: queueClock.queue,
    clock: queueClock.clock,
    actorHost: createInMemoryActorHost(),
  });
}
