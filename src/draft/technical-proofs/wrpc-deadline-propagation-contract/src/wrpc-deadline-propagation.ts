import { isJsonString } from "./json.js";
export class DeadlineExceededError extends Error {
  constructor({ componentId, importInterface, operation, deadline }) {
    super("wrpc.deadline_exceeded");
    this.name = "DeadlineExceededError";
    this.code = "deadline-exceeded";
    this.componentId = componentId;
    this.importInterface = importInterface;
    this.operation = operation;
    this.deadline = deadline;
    this.failure = {
      class: "transient",
      reason: "deadline-exceeded",
      strategy: {
        kind: "backoff-budget",
        retry: "capped-exponential-backoff-with-jitter",
        terminalAfter: "retry-budget",
      },
    };
  }
}

export function createManualClock(startMs = 0) {
  let nowMs = startMs;
  const sleepers = [];

  function sleep(durationMs, { signal } = {}) {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }

    return new Promise((resolve, reject) => {
      const entry = {
        dueAtMs: nowMs + Math.max(0, durationMs),
        resolve,
        reject,
        cleanup: () => {},
      };

      if (signal) {
        const onAbort = () => {
          remove(entry);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener("abort", onAbort);
      }

      sleepers.push(entry);
      flush();
    });
  }

  function advance(durationMs) {
    nowMs += Math.max(0, durationMs);
    flush();
  }

  function flush() {
    sleepers.sort((left, right) => left.dueAtMs - right.dueAtMs);

    for (let index = 0; index < sleepers.length;) {
      const entry = sleepers[index];
      if (entry.dueAtMs > nowMs) {
        index += 1;
        continue;
      }

      sleepers.splice(index, 1);
      entry.cleanup();
      entry.resolve();
    }
  }

  function remove(entry) {
    const index = sleepers.indexOf(entry);
    if (index >= 0) {
      sleepers.splice(index, 1);
    }
    entry.cleanup();
  }

  return {
    nowMs: () => nowMs,
    sleep,
    advance,
  };
}

export function createDeadlinePropagationMembrane({
  clock = createManualClock(0),
  codec = createJsonWitCodec(),
} = {}) {
  return new DeadlinePropagationMembrane({ clock, codec });
}

export function createJsonWitCodec() {
  return Object.freeze({
    name: "json-wit",
    encode(value) {
      return structuredClone(value);
    },
    decode(value) {
      return structuredClone(value);
    },
  });
}

class DeadlinePropagationMembrane {
  #components = new Map();
  #providers = new Map();
  #links = new Map();

  constructor({ clock, codec }) {
    this.clock = clock;
    this.codec = codec;
    this.events = [];
  }

  registerComponent(component) {
    assertId(component?.id, "component");
    this.#components.set(component.id, {
      id: component.id,
      imports: new Set(component.imports ?? []),
    });
  }

  registerProvider(provider) {
    assertId(provider?.id, "provider");
    this.#providers.set(provider.id, {
      id: provider.id,
      exports: provider.exports ,
    });
  }

  link({ componentId, importInterface, providerId, exportInterface }) {
    const component = this.#requireComponent(componentId);
    if (!component.imports.has(importInterface)) {
      throw new Error(`wrpc.import_not_declared: ${componentId}:${importInterface}`);
    }

    const provider = this.#requireProvider(providerId);
    if (!provider.exports[exportInterface]) {
      throw new Error(`wrpc.export_not_found: ${providerId}:${exportInterface}`);
    }

    const link = Object.freeze({
      componentId,
      importInterface,
      providerId,
      exportInterface,
      transport: "in-process",
      boundaryMode: "live",
    });
    this.#links.set(linkKey(componentId, importInterface), link);
    this.events.push({ type: "link.Established", ...link });
    return link;
  }

  async callImport(componentId, importInterface, operation, payload = {}, options = {}) {
    this.#requireComponent(componentId);
    const link = this.#links.get(linkKey(componentId, importInterface));
    if (!link) {
      throw new Error(`wrpc.no_route: ${componentId}:${importInterface}`);
    }

    const provider = this.#requireProvider(link.providerId);
    const implementation = provider.exports?.[link.exportInterface]?.[operation];
    if (!(implementation instanceof Function)) {
      throw new Error(`wrpc.operation_not_found: ${link.exportInterface}.${operation}`);
    }

    const deadline = createDeadline(this.clock.nowMs(), options);
    const abort = new AbortController();
    let outcome = "ok";
    let failureClass = null;
    let cancellation = "not-needed";
    const deadlineError = deadline
      ? new DeadlineExceededError({ componentId, importInterface, operation, deadline })
      : null;
    const timeoutAbort = new AbortController();

    const timeout = deadline
      ? this.clock
          .sleep(deadline.remainingAtDispatchMs, { signal: timeoutAbort.signal })
          .then(() => {
            outcome = "deadline-exceeded";
            failureClass = deadlineError.failure.class;
            cancellation = "signaled";
            abort.abort(deadlineError);
            throw deadlineError;
          })
          .catch((error) => {
            if (timeoutAbort.signal.aborted && error === timeoutAbort.signal.reason) {
              return new Promise(() => {});
            }
            throw error;
          })
      : new Promise(() => {});

    const context = {
      componentId,
      importInterface,
      operation,
      deadline,
      signal: abort.signal,
      sleep: (durationMs) => this.clock.sleep(durationMs, { signal: abort.signal }),
      callLinked: (nextImportInterface, nextOperation, nextPayload = {}, nextOptions = {}) =>
        this.callImport(componentId, nextImportInterface, nextOperation, nextPayload, {
          ...nextOptions,
          parentDeadline: deadline,
        }),
    };

    const operationResult = Promise.resolve()
      .then(() => implementation(this.codec.encode(payload), context))
      .then((encodedResult) => this.codec.decode(encodedResult));

    try {
      return await Promise.race([operationResult, timeout]);
    } catch (error) {
      if (error?.code === "deadline-exceeded") {
        throw error;
      }
      if (abort.signal.aborted && abort.signal.reason?.code === "deadline-exceeded") {
        throw abort.signal.reason;
      }
      outcome = "error";
      throw error;
    } finally {
      timeoutAbort.abort(new Error("deadline-timer-cancelled"));
      this.events.push({
        type: "link.Called",
        componentId,
        importInterface,
        providerId: link.providerId,
        exportInterface: link.exportInterface,
        operation,
        transport: link.transport,
        boundaryMode: link.boundaryMode,
        deadline,
        outcome,
        failureClass,
        cancellation,
        codec: this.codec.name,
      });
    }
  }

  report() {
    return {
      schema: "hobo.wrpc.deadline-propagation/v1",
      issue: "HOBO-24",
      supportedTransports: ["in-process"],
      events: ["link.Established", "link.Called"],
      scopeIn: [
        "caller deadline carried on link.Called",
        "deadline-exceeded result classified as Plan-5 transient timeout",
        "AbortSignal cancellation for cancellable provider operations",
        "nested in-process calls inherit and shrink remaining deadline",
        "hung in-process providers cannot hold the caller past deadline",
      ],
      scopeOut: [
        "NATS/JetStream lattice transport",
        "cross-host hung-call timing divergence",
        "backpressure handling",
        "retry or provider idempotency reconciliation",
        "full failure-classifier implementation",
        "wire-version negotiation",
      ],
    };
  }

  #requireComponent(componentId) {
    const component = this.#components.get(componentId);
    if (!component) {
      throw new Error(`wrpc.component_not_registered: ${componentId}`);
    }
    return component;
  }

  #requireProvider(providerId) {
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw new Error(`wrpc.provider_not_registered: ${providerId}`);
    }
    return provider;
  }
}

function createDeadline(nowMs, options) {
  const parent = options.parentDeadline ?? null;
  const requestedExpiresAtMs =
    Number.isFinite(options.deadlineAtMs)
      ? options.deadlineAtMs
      : Number.isFinite(options.timeoutMs)
        ? nowMs + options.timeoutMs
        : null;

  if (!parent && requestedExpiresAtMs === null) {
    return null;
  }

  const expiresAtMs =
    parent && requestedExpiresAtMs !== null
      ? Math.min(parent.expiresAtMs, requestedExpiresAtMs)
      : parent?.expiresAtMs ?? requestedExpiresAtMs;

  return Object.freeze({
    source: parent && (requestedExpiresAtMs === null || parent.expiresAtMs <= requestedExpiresAtMs)
      ? "inherited"
      : "caller",
    startedAtMs: nowMs,
    expiresAtMs,
    remainingAtDispatchMs: Math.max(0, expiresAtMs - nowMs),
  });
}

function linkKey(componentId, importInterface) {
  return `${componentId}\0${importInterface}`;
}

function assertId(id, kind) {
  if (!isJsonString(id) || id.length === 0) {
    throw new Error(`wrpc.${kind}_id_required`);
  }
}
