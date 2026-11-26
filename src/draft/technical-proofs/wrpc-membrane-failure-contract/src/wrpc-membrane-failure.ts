import { createRuntimeLocalEventStore } from "../../camp-eventstore-runtime-port-contract/src/camp-eventstore-runtime-port.js";
import { classifyFailure } from "../../system-failure-classifier-contract/src/classifier.js";
import { isJsonString, isJsonObject } from "./json.js";


export const MEMBRANE_FAILURE_CONTRACT_VERSION = "hobo.wrpc-membrane-failure/v1";

export class MembraneOverloadedError extends Error {
  constructor({ providerId, operation, importInterface, maxInFlight, inFlight }) {
    super(`wrpc.overloaded: ${providerId}.${operation}`);
    this.name = "MembraneOverloadedError";
    this.code = "WRPC_OVERLOADED";
    this.membrane = "overloaded";
    this.providerId = providerId;
    this.operation = operation;
    this.importInterface = importInterface;
    this.maxInFlight = maxInFlight;
    this.inFlight = inFlight;
    this.failure = classifyFailure({
      membrane: this.membrane,
      providerId,
      operation,
      importInterface,
    });
  }
}

export class MembraneSeveredError extends Error {
  constructor({ providerId, operation, importInterface, committed = "unknown" }) {
    super(`wrpc.severed: ${providerId}.${operation}`);
    this.name = "MembraneSeveredError";
    this.code = "WRPC_SEVERED";
    this.membrane = "severed";
    this.providerId = providerId;
    this.operation = operation;
    this.importInterface = importInterface;
    this.committed = committed;
    this.ambiguousCommit = committed === "unknown";
    this.failure = classifyFailure({
      membrane: this.membrane,
      providerId,
      operation,
      importInterface,
      ambiguousCommit: this.ambiguousCommit,
    });
  }
}

export class AmbiguousReturnError extends Error {
  constructor({ providerId, operation, importInterface }) {
    super(`wrpc.ambiguous_return: ${providerId}.${operation}`);
    this.name = "AmbiguousReturnError";
    this.code = "WRPC_AMBIGUOUS_RETURN";
    this.membrane = "ambiguous-return";
    this.providerId = providerId;
    this.operation = operation;
    this.importInterface = importInterface;
    this.ambiguousCommit = true;
    this.failure = classifyFailure({
      membrane: this.membrane,
      providerId,
      operation,
      importInterface,
      ambiguousCommit: true,
    });
  }
}

export function createMembraneFailureContract() {
  return new MembraneFailureContract();
}

export async function reconcileAmbiguousFailure({ call, eventStore, membrane, error }) {
  const failure = classifyFailure(error);
  if (failure.class !== "partial-failure" || failure.requiresIdempotencyDecision !== true) {
    return Object.freeze({
      outcome: "not-ambiguous",
      failure,
    });
  }

  if (call?.effectKind === "eventstore-append") {
    const appendResult = await eventStore.append(
      requireNonEmptyString(call.streamId, "call.streamId"),
      [call.event],
      {
        expectedSeq: normalizeNonNegativeInteger(call.expectedSeq, "call.expectedSeq"),
        actor: { kind: "system", id: "wrpc-membrane" },
        tenant: call.tenant ?? "conformance-tenant",
      },
    );

    return Object.freeze({
      outcome:
        appendResult.deduped.length > 0 ? "deduped-eventstore-effect" : "appended-once",
      failure,
      appendResult,
    });
  }

  if (call?.effectKind === "provider-rpc") {
    try {
      const result = await membrane.callProvider(call.providerId, call.operation, {
        importInterface: call.importInterface,
        payload: call.payload ?? {},
        idempotencyKey: requireNonEmptyString(call.idempotencyKey, "call.idempotencyKey"),
      });
      const attempt = membrane.providerRpcAttempt({
        providerId: call.providerId,
        operation: call.operation,
        idempotencyKey: call.idempotencyKey,
      });

      return Object.freeze({
        outcome:
          attempt.count > 1 ? "provider-idempotency-forwarded" : "retried-provider-rpc",
        failure,
        result,
      });
    } catch (caught) {
      if (caught instanceof MembraneOverloadedError) {
        return Object.freeze({
          outcome: "shed-overloaded",
          failure: caught.failure,
          retrySuppressed: true,
        });
      }
      throw caught;
    }
  }

  throw new Error(`unsupported ambiguous failure effect: ${call?.effectKind ?? "<missing>"}`);
}

export async function runMembraneFailureConformance() {
  const assertions = {
    boundedBackpressure: (await provesBoundedBackpressure()) ? "pass" : "fail",
    severedClassifiedPartial: (await provesSeveredClassifiedPartial()) ? "pass" : "fail",
    eventStoreAppendDedup: (await provesEventStoreAppendDedup()) ? "pass" : "fail",
    providerRpcIdempotencyForwarded: (await provesProviderRpcIdempotencyForwarded())
      ? "pass"
      : "fail",
    retryStormShed: (await provesRetryStormShed()) ? "pass" : "fail",
  };

  return Object.freeze({
    contract: MEMBRANE_FAILURE_CONTRACT_VERSION,
    issue: "HOBO-25",
    componentHostSuite: "@hobo/conformance/component-host",
    assertions: Object.freeze(assertions),
    scopeIn: Object.freeze([
      "bounded membrane backpressure",
      "overloaded, severed, and ambiguous-return failure signals",
      "EventStore append idempotency reconciliation",
      "provider RPC idempotency-key forwarding obligation",
      "retry storm shedding while saturated",
    ]),
    scopeOut: Object.freeze([
      "NATS/JetStream transport implementation",
      "per-provider idempotency implementations",
      "Reactor client coalescing",
    ]),
  });
}

class MembraneFailureContract {
  #providers = new Map();
  #providerRpcAttempts = new Map();

  constructor() {
    this.events = [];
  }

  registerProvider(provider) {
    const id = requireNonEmptyString(provider?.id, "provider.id");
    const maxInFlight = normalizeNonNegativeInteger(
      provider.maxInFlight ?? 32,
      "provider.maxInFlight",
    );
    if (!provider.operations || !isJsonObject(provider.operations)) {
      throw new TypeError("provider.operations must be an object");
    }

    this.#providers.set(id, {
      id,
      maxInFlight,
      inFlight: 0,
      callsStarted: 0,
      operations: provider.operations,
    });
  }

  async callProvider(providerId, operation, context = {}) {
    const provider = this.#requireProvider(providerId);
    const op = requireNonEmptyString(operation, "operation");
    const implementation = provider.operations[op];
    if (!(implementation instanceof Function)) {
      throw new Error(`wrpc.operation_not_found: ${providerId}.${op}`);
    }

    if (provider.inFlight >= provider.maxInFlight) {
      const error = new MembraneOverloadedError({
        providerId,
        operation: op,
        importInterface: context.importInterface,
        maxInFlight: provider.maxInFlight,
        inFlight: provider.inFlight,
      });
      this.events.push(toFailureEvent("link.Rejected", error, context));
      throw error;
    }

    provider.inFlight += 1;
    provider.callsStarted += 1;
    this.events.push({
      type: "link.Called",
      providerId,
      operation: op,
      importInterface: context.importInterface,
      idempotencyKey: context.idempotencyKey,
      inFlight: provider.inFlight,
    });

    try {
      return await implementation(context.payload ?? {}, {
        providerId,
        operation: op,
        importInterface: context.importInterface,
        idempotencyKey: context.idempotencyKey,
      });
    } catch (error) {
      if (isMembraneFailure(error)) {
        this.events.push(toFailureEvent("link.Failed", error, context));
      }
      throw error;
    } finally {
      provider.inFlight -= 1;
    }
  }

  providerRpcAttempt({ providerId, operation, idempotencyKey }) {
    const key = [
      requireNonEmptyString(providerId, "providerId"),
      requireNonEmptyString(operation, "operation"),
      requireNonEmptyString(idempotencyKey, "idempotencyKey"),
    ].join("\0");
    const count = (this.#providerRpcAttempts.get(key) ?? 0) + 1;
    this.#providerRpcAttempts.set(key, count);
    return Object.freeze({ key, count });
  }

  report() {
    const providers = {};
    for (const [id, provider] of this.#providers) {
      providers[id] = {
        maxInFlight: provider.maxInFlight,
        inFlight: provider.inFlight,
        callsStarted: provider.callsStarted,
      };
    }

    return Object.freeze({
      contract: MEMBRANE_FAILURE_CONTRACT_VERSION,
      issue: "HOBO-25",
      providers,
      events: structuredClone(this.events),
    });
  }

  #requireProvider(providerId) {
    const id = requireNonEmptyString(providerId, "providerId");
    const provider = this.#providers.get(id);
    if (!provider) {
      throw new Error(`wrpc.provider_not_registered: ${id}`);
    }
    return provider;
  }
}

async function provesBoundedBackpressure() {
  const membrane = createMembraneFailureContract();
  membrane.registerProvider({
    id: "kv",
    maxInFlight: 1,
    operations: { get: () => new Promise(() => {}) },
  });
  membrane.callProvider("kv", "get", {
    importInterface: "wasi:keyvalue/store.get",
    idempotencyKey: "read-1",
  }).catch(() => {});

  try {
    await membrane.callProvider("kv", "get", {
      importInterface: "wasi:keyvalue/store.get",
      idempotencyKey: "read-2",
    });
    return false;
  } catch (error) {
    return error instanceof MembraneOverloadedError && error.failure.class === "transient";
  }
}

async function provesSeveredClassifiedPartial() {
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
    effectKind: "eventstore-append",
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
  const seen = [];
  const membrane = createMembraneFailureContract();
  membrane.registerProvider({
    id: "provider",
    maxInFlight: 1,
    operations: {
      write: (_payload, context) => {
        seen.push(context.idempotencyKey);
        return { ok: true };
      },
    },
  });
  const call = {
    effectKind: "provider-rpc",
    providerId: "provider",
    operation: "write",
    importInterface: "wasi:keyvalue/store.set",
    idempotencyKey: "write-1",
  };

  await reconcileAmbiguousFailure({
    call,
    membrane,
    error: new AmbiguousReturnError({
      providerId: "provider",
      operation: "write",
      importInterface: "wasi:keyvalue/store.set",
    }),
  });
  const retry = await reconcileAmbiguousFailure({
    call,
    membrane,
    error: new AmbiguousReturnError({
      providerId: "provider",
      operation: "write",
      importInterface: "wasi:keyvalue/store.set",
    }),
  });

  return retry.outcome === "provider-idempotency-forwarded" && seen.join(",") === "write-1,write-1";
}

async function provesRetryStormShed() {
  const membrane = createMembraneFailureContract();
  membrane.registerProvider({
    id: "mail",
    maxInFlight: 0,
    operations: { send: () => ({ ok: true }) },
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

function isMembraneFailure(error) {
  return (
    error instanceof MembraneOverloadedError ||
    error instanceof MembraneSeveredError ||
    error instanceof AmbiguousReturnError
  );
}

function toFailureEvent(type, error, context) {
  return {
    type,
    providerId: error.providerId,
    operation: error.operation,
    importInterface: error.importInterface ?? context.importInterface,
    membrane: error.membrane,
    failureClass: error.failure.class,
    idempotencyKey: context.idempotencyKey,
  };
}

function normalizeNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function requireNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}
