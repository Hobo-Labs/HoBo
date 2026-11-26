import { createRuntimeLocalEventStore } from "../../camp-eventstore-runtime-port-contract/src/camp-eventstore-runtime-port.js";
import { createManualClock } from "./manual-clock.js";
import {
  AmbiguousReturnError,
  createMembraneDeadlineBackpressure,
  DeadlineExceededError,
  MembraneOverloadedError,
  MembraneSeveredError,
} from "./membrane.js";
import { reconcileAmbiguousFailure } from "./reconcile-ambiguous-failure.js";
import { type JsonValue } from "./json.js";


const KV = "wasi:keyvalue/store@0.2.0";
const WORKFLOW = "hobo:runtime/workflow@0.1.0";

export const MEMBRANE_FAILURE_LANE_VERSION = "hobo.membrane-failure-lane/v1";

export interface MembraneFailureLaneReport {
  contract: typeof MEMBRANE_FAILURE_LANE_VERSION;
  issue: "HOBO-598";
  assertions: Readonly<Record<string, "pass" | "fail">>;
  elapsedMs: number;
}

export async function runMembraneFailureLane(): Promise<MembraneFailureLaneReport> {
  const started = Date.now();
  const watchdog = setTimeout(() => {
    throw new Error("membrane failure lane exceeded 5s wall-clock watchdog");
  }, 5_000);

  try {
    const assertions = {
      slowProviderTypedTimeout: (await provesSlowProviderTypedTimeout()) ? "pass" : "fail",
      nestedDeadlineShrinks: (await provesNestedDeadlineShrinks()) ? "pass" : "fail",
      hungProviderNeverHangs: (await provesHungProviderNeverHangs()) ? "pass" : "fail",
      boundedBackpressure: (await provesBoundedBackpressure()) ? "pass" : "fail",
      severedClassifiedPartial: provesSeveredClassifiedPartial() ? "pass" : "fail",
      eventStoreAppendDedup: (await provesEventStoreAppendDedup()) ? "pass" : "fail",
      providerRpcIdempotencyForwarded: (await provesProviderRpcIdempotencyForwarded())
        ? "pass"
        : "fail",
      retryStormShed: (await provesRetryStormShed()) ? "pass" : "fail",
    } as const;

    return Object.freeze({
      contract: MEMBRANE_FAILURE_LANE_VERSION,
      issue: "HOBO-598",
      assertions,
      elapsedMs: Date.now() - started,
    });
  } finally {
    clearTimeout(watchdog);
  }
}

async function provesSlowProviderTypedTimeout() {
  const clock = createManualClock(0);
  const membrane = createMembraneDeadlineBackpressure({ clock });

  membrane.registerComponent({ id: "api", imports: [KV] });
  membrane.registerProvider({
    id: "slow-kv",
    exports: {
      [KV]: {
        get: async (_payload, context) => {
          await context.sleep(50);
          return { value: "too-late" };
        },
      },
    },
  });
  membrane.link({
    componentId: "api",
    importInterface: KV,
    providerId: "slow-kv",
    exportInterface: KV,
  });

  const call = membrane.callImport("api", KV, "get", { key: "session" }, { timeoutMs: 10 });
  await Promise.resolve();
  clock.advance(11);

  try {
    await call;
    return false;
  } catch (error) {
    if (!(error instanceof DeadlineExceededError)) {
      return false;
    }
    const last = membrane.events.at(-1);
    return (
      error.failure.class === "transient" &&
      last?.type === "link.Called" &&
      last.outcome === "deadline-exceeded" &&
      last.failureClass === "transient" &&
      last.cancellation === "signaled"
    );
  }
}

async function provesNestedDeadlineShrinks() {
  const clock = createManualClock(100);
  const membrane = createMembraneDeadlineBackpressure({ clock });
  const innerDeadlines: Array<JsonValue> = [];

  membrane.registerComponent({ id: "api", imports: [WORKFLOW, KV] });
  membrane.registerProvider({
    id: "workflow-runtime",
    exports: {
      [WORKFLOW]: {
        run: async (_payload, context) => {
          await context.sleep(30);
          return context.callLinked(KV, "get", { key: "nested" });
        },
      },
    },
  });
  membrane.registerProvider({
    id: "local-kv",
    exports: {
      [KV]: {
        get: (_payload, context) => {
          innerDeadlines.push(context.deadline);
          return { value: "nested-ok" };
        },
      },
    },
  });
  membrane.link({
    componentId: "api",
    importInterface: WORKFLOW,
    providerId: "workflow-runtime",
    exportInterface: WORKFLOW,
  });
  membrane.link({
    componentId: "api",
    importInterface: KV,
    providerId: "local-kv",
    exportInterface: KV,
  });

  const call = membrane.callImport("api", WORKFLOW, "run", {}, { timeoutMs: 80 });
  await Promise.resolve();
  clock.advance(30);
  await call;

  return (
    innerDeadlines.length === 1 &&
    // SAFETY: assertion to `(innerDeadlines[0] as { remainingAtDispatchMs: number }).remainingAtDispatchMs =` is required at this boundary.
    (innerDeadlines[0] as { remainingAtDispatchMs: number }).remainingAtDispatchMs === 50
  );
}

async function provesHungProviderNeverHangs() {
  const clock = createManualClock(0);
  const membrane = createMembraneDeadlineBackpressure({ clock });

  membrane.registerComponent({ id: "api", imports: [KV] });
  membrane.registerProvider({
    id: "hung-kv",
    exports: {
      [KV]: {
        get: () => new Promise(() => {}),
      },
    },
  });
  membrane.link({
    componentId: "api",
    importInterface: KV,
    providerId: "hung-kv",
    exportInterface: KV,
  });

  const call = membrane.callImport("api", KV, "get", { key: "never" }, { timeoutMs: 5 });
  await Promise.resolve();
  clock.advance(6);

  try {
    await call;
    return false;
  } catch (error) {
    return (
      error instanceof DeadlineExceededError &&
      membrane.events.at(-1)?.outcome === "deadline-exceeded"
    );
  }
}

async function provesBoundedBackpressure() {
  const membrane = createMembraneDeadlineBackpressure();
  membrane.registerProvider({
    id: "kv",
    maxInFlight: 1,
    exports: {
      "*": {
        get: () => new Promise(() => {}),
      },
    },
  });

  membrane.callProvider("kv", "get", {
    importInterface: KV,
    idempotencyKey: "read-1",
  }).catch(() => {});

  try {
    await membrane.callProvider("kv", "get", {
      importInterface: KV,
      idempotencyKey: "read-2",
    });
    return false;
  } catch (error) {
    return (
      error instanceof MembraneOverloadedError &&
      error.failure.class === "transient" &&
      membrane.report().providers.kv.callsStarted === 1
    );
  }
}

function provesSeveredClassifiedPartial() {
  const error = new MembraneSeveredError({
    providerId: "blob",
    operation: "streamPut",
    importInterface: "wasi:io/streams.write",
    committed: "unknown",
  });
  return error.failure.class === "partial-failure" && error.failure.requiresIdempotencyDecision;
}

async function provesEventStoreAppendDedup() {
  const eventStore = createRuntimeLocalEventStore();
  const call = {
    effectKind: "eventstore-append" as const,
    streamId: "conformance:orders",
    expectedSeq: 0,
    event: {
      type: "order.Reserved",
      data: { orderId: "42" },
      meta: { idempotencyKey: "reserve-42" },
    },
  };

  await reconcileAmbiguousFailure({
    call,
    eventStore,
    error: new AmbiguousReturnError({
      providerId: "eventstore",
      operation: "append",
      importInterface: "hobo:eventstore.append",
    }),
  });
  const retry = await reconcileAmbiguousFailure({
    call,
    eventStore,
    error: new AmbiguousReturnError({
      providerId: "eventstore",
      operation: "append",
      importInterface: "hobo:eventstore.append",
    }),
  });

  return retry.outcome === "deduped-eventstore-effect";
}

async function provesProviderRpcIdempotencyForwarded() {
  const seen: string[] = [];
  const membrane = createMembraneDeadlineBackpressure();
  membrane.registerProvider({
    id: "provider",
    maxInFlight: 1,
    exports: {
      "*": {
        write: (_payload, context) => {
          seen.push(context.idempotencyKey ?? "");
          return { ok: true };
        },
      },
    },
  });

  const call = {
    effectKind: "provider-rpc" as const,
    providerId: "provider",
    operation: "write",
    importInterface: KV,
    idempotencyKey: "write-1",
  };

  await reconcileAmbiguousFailure({
    call,
    membrane,
    error: new AmbiguousReturnError({
      providerId: "provider",
      operation: "write",
      importInterface: KV,
    }),
  });
  const retry = await reconcileAmbiguousFailure({
    call,
    membrane,
    error: new AmbiguousReturnError({
      providerId: "provider",
      operation: "write",
      importInterface: KV,
    }),
  });

  return retry.outcome === "provider-idempotency-forwarded" && seen.join(",") === "write-1,write-1";
}

async function provesRetryStormShed() {
  const membrane = createMembraneDeadlineBackpressure();
  membrane.registerProvider({
    id: "mail",
    maxInFlight: 0,
    exports: {
      "*": {
        send: () => ({ ok: true }),
      },
    },
  });

  const outcomes = await Promise.all(
    Array.from({ length: 3 }, (_, index) =>
      reconcileAmbiguousFailure({
        membrane,
        call: {
          effectKind: "provider-rpc",
          providerId: "mail",
          operation: "send",
          importInterface: "wasi:messaging/send",
          idempotencyKey: `mail-${index}`,
        },
        error: new AmbiguousReturnError({
          providerId: "mail",
          operation: "send",
          importInterface: "wasi:messaging/send",
        }),
      }),
    ),
  );

  return (
    outcomes.every((outcome) => outcome.outcome === "shed-overloaded") &&
    membrane.report().providers.mail.callsStarted === 0
  );
}
