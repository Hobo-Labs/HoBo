import type {
  createInMemoryActorHost,
} from "../fixtures/actor-host-port.js";
import type {
  createRuntimeLocalEventStore,
} from "../fixtures/eventstore-port.js";
import type { createRuntimeLocalQueueClock } from "../fixtures/queue-clock-port.js";

export const RUNTIME_PORT_CONFORMANCE_VERSION =
  "hobo.runtime-port-conformance/v1";

export type EventStorePort = ReturnType<typeof createRuntimeLocalEventStore>;
export type QueueClockBundle = ReturnType<typeof createRuntimeLocalQueueClock>;
export type QueuePort = QueueClockBundle["queue"];
export type ClockPort = QueueClockBundle["clock"];
export type ActorHostPort = ReturnType<typeof createInMemoryActorHost>;

export interface RuntimeDurabilityBackend {
  readonly name: string;
  readonly eventStore: EventStorePort;
  readonly queue: QueuePort;
  readonly clock: ClockPort;
  readonly actorHost: ActorHostPort;
}

// domain-view: readonly parse-produced report shape; its wire form is the runtime-port/conformance proto message of the same name.
export interface ConformanceCheckResult {
  readonly checkId: string;
  readonly port: string;
  readonly tag: "local";
  readonly status: "pass" | "fail";
}

// domain-view: readonly parse-produced report shape; its wire form is the runtime-port/conformance proto message of the same name.
export interface ConformanceFailure {
  readonly checkId: string;
  readonly message: string;
}

// domain-view: readonly parse-produced report shape; its wire form is the runtime-port/conformance proto message of the same name.
export interface RuntimePortConformanceReport {
  readonly contract: typeof RUNTIME_PORT_CONFORMANCE_VERSION;
  readonly backend: string;
  readonly status: "pass" | "fail";
  readonly checks: readonly ConformanceCheckResult[];
  readonly failures: readonly ConformanceFailure[];
  readonly coverage: {
    readonly local: {
      readonly status: "pass" | "fail";
      readonly passed: number;
      readonly failed: number;
      readonly total: number;
    };
  };
}
