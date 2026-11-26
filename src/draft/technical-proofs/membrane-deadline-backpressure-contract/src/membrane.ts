import { deriveDeadline, type Deadline } from "./deadline.js";
import {
  AmbiguousReturnError,
  DeadlineExceededError,
  MembraneOverloadedError,
  MembraneSeveredError,
} from "./errors.js";
import { createManualClock, type ManualClock } from "./manual-clock.js";
import { isJsonString, type JsonValue } from "./json.js";


export const MEMBRANE_CONTRACT_VERSION = "hobo.membrane-deadline-backpressure/v1";

export interface WitCodec {
  readonly name: string;
  encode(value: JsonValue): JsonValue;
  decode(value: JsonValue): JsonValue;
}

export interface CallContext {
  componentId: string;
  importInterface: string;
  operation: string;
  deadline: Deadline | null;
  signal: AbortSignal;
  sleep: (durationMs: number) => Promise<void>;
  callLinked: (
    nextImportInterface: string,
    nextOperation: string,
    nextPayload?: JsonValue,
    nextOptions?: CallOptions,
  ) => Promise<JsonValue>;
  idempotencyKey?: string;
}

export interface CallOptions {
  timeoutMs?: number;
  deadlineAtMs?: number;
  parentDeadline?: Deadline | null;
  idempotencyKey?: string;
}

export interface ProviderRegistration {
  id: string;
  maxInFlight?: number;
  exports: Record<
    string,
    Record<string, (payload: JsonValue, context: CallContext) => JsonValue | Promise<JsonValue>>
  >;
}

export type MembraneEvent =
  | LinkEstablishedEvent
  | LinkCalledEvent
  | LinkRejectedEvent
  | LinkFailedEvent;

interface LinkEstablishedEvent {
  type: "link.Established";
  componentId: string;
  importInterface: string;
  providerId: string;
  exportInterface: string;
  transport: "in-process";
  boundaryMode: "live";
}

interface LinkCalledEvent {
  type: "link.Called";
  componentId: string;
  importInterface: string;
  providerId: string;
  exportInterface: string;
  operation: string;
  transport: "in-process";
  boundaryMode: "live";
  deadline: Deadline | null;
  outcome: "ok" | "deadline-exceeded" | "error";
  failureClass: string | null;
  cancellation: "not-needed" | "signaled";
  codec: string;
  idempotencyKey?: string;
  inFlight?: number;
}

interface LinkRejectedEvent {
  type: "link.Rejected";
  providerId: string;
  operation: string;
  importInterface?: string;
  membrane: "overloaded";
  failureClass: string;
  maxInFlight: number;
  inFlight: number;
  idempotencyKey?: string;
}

interface LinkFailedEvent {
  type: "link.Failed";
  providerId: string;
  operation: string;
  importInterface?: string;
  membrane: string;
  failureClass: string;
  idempotencyKey?: string;
}

interface ProviderState {
  id: string;
  maxInFlight: number;
  inFlight: number;
  callsStarted: number;
  exports: ProviderRegistration["exports"];
}

export function createJsonWitCodec(): WitCodec {
  return Object.freeze({
    name: "json-wit",
    encode(value: JsonValue) {
      return structuredClone(value);
    },
    decode(value: JsonValue) {
      return structuredClone(value);
    },
  });
}

export function createMembraneDeadlineBackpressure(options: {
  clock?: ManualClock;
  codec?: WitCodec;
} = {}) {
  return new MembraneDeadlineBackpressure({
    clock: options.clock ?? createManualClock(0),
    codec: options.codec ?? createJsonWitCodec(),
  });
}

export class MembraneDeadlineBackpressure {
  readonly clock: ManualClock;
  readonly codec: WitCodec;
  readonly events: MembraneEvent[] = [];

  #components = new Map<string, { id: string; imports: Set<string> }>();
  #providers = new Map<string, ProviderState>();
  #links = new Map<string, EstablishedLink>();
  #providerRpcAttempts = new Map<string, number>();

  constructor({ clock, codec }: { clock: ManualClock; codec: WitCodec }) {
    this.clock = clock;
    this.codec = codec;
  }

  registerComponent(component: { id: string; imports: string[] }) {
    assertId(component.id, "component");
    this.#components.set(component.id, {
      id: component.id,
      imports: new Set(component.imports ?? []),
    });
  }

  registerProvider(provider: ProviderRegistration) {
    assertId(provider.id, "provider");
    this.#providers.set(provider.id, {
      id: provider.id,
      maxInFlight: normalizeNonNegativeInteger(provider.maxInFlight ?? 32, "maxInFlight"),
      inFlight: 0,
      callsStarted: 0,
      exports: provider.exports ?? {},
    });
  }

  link(request: {
    componentId: string;
    importInterface: string;
    providerId: string;
    exportInterface: string;
  }) {
    const component = this.#requireComponent(request.componentId);
    if (!component.imports.has(request.importInterface)) {
      throw new Error(`wrpc.import_not_declared: ${request.componentId}:${request.importInterface}`);
    }

    const provider = this.#requireProvider(request.providerId);
    if (!provider.exports[request.exportInterface]) {
      throw new Error(`wrpc.export_not_found: ${request.providerId}:${request.exportInterface}`);
    }

    const link = Object.freeze({
      componentId: request.componentId,
      importInterface: request.importInterface,
      providerId: request.providerId,
      exportInterface: request.exportInterface,
      transport: "in-process" as const,
      boundaryMode: "live" as const,
    });
    this.#links.set(linkKey(request.componentId, request.importInterface), link);
    this.events.push({ type: "link.Established", ...link });
    return link;
  }

  async callImport(
    componentId: string,
    importInterface: string,
    operation: string,
    payload: JsonValue = {},
    options: CallOptions = {},
  ) {
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

    if (provider.inFlight >= provider.maxInFlight) {
      const error = new MembraneOverloadedError({
        providerId: link.providerId,
        operation,
        importInterface,
        maxInFlight: provider.maxInFlight,
        inFlight: provider.inFlight,
      });
      this.events.push({
        type: "link.Rejected",
        providerId: link.providerId,
        operation,
        importInterface,
        membrane: "overloaded",
        failureClass: error.failure.class,
        maxInFlight: provider.maxInFlight,
        inFlight: provider.inFlight,
        idempotencyKey: options.idempotencyKey,
      });
      throw error;
    }

    const deadline = deriveDeadline(this.clock.nowMs(), options);
    const abort = new AbortController();
    let outcome: LinkCalledEvent["outcome"] = "ok";
    let failureClass: string | null = null;
    let cancellation: LinkCalledEvent["cancellation"] = "not-needed";
    const deadlineError = deadline
      ? new DeadlineExceededError({ componentId, importInterface, operation, deadline })
      : null;
    const timeoutAbort = new AbortController();

    const timeout = deadline
      ? this.clock
          .sleep(deadline.remainingAtDispatchMs, { signal: timeoutAbort.signal })
          .then(() => {
            outcome = "deadline-exceeded";
            failureClass = deadlineError!.failure.class;
            cancellation = "signaled";
            abort.abort(deadlineError);
            throw deadlineError;
          })
          .catch((error) => {
            if (timeoutAbort.signal.aborted && error === timeoutAbort.signal.reason) {
              return new Promise<never>(() => {});
            }
            throw error;
          })
      : new Promise<never>(() => {});

    provider.inFlight += 1;
    provider.callsStarted += 1;

    const context: CallContext = {
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
      idempotencyKey: options.idempotencyKey,
    };

    const operationResult = Promise.resolve()
      .then(() => implementation(this.codec.encode(payload), context))
      .then((encodedResult) => this.codec.decode(encodedResult));

    try {
      return await Promise.race([operationResult, timeout]);
    } catch (error) {
      if (isMembraneFailure(error)) {
        this.events.push(toFailureEvent("link.Failed", error, {
          importInterface,
          idempotencyKey: options.idempotencyKey,
        }));
      }
      if (
        error instanceof DeadlineExceededError ||
        // SAFETY: assertion to `(error as { code?: string })?.code === "deadline-exceeded"` is required at this boundary.
        (error as { code?: string })?.code === "deadline-exceeded"
      ) {
        throw error;
      }
      if (abort.signal.aborted && abort.signal.reason instanceof DeadlineExceededError) {
        throw abort.signal.reason;
      }
      outcome = "error";
      throw error;
    } finally {
      provider.inFlight -= 1;
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
        idempotencyKey: options.idempotencyKey,
        inFlight: provider.inFlight,
      });
    }
  }

  async callProvider(
    providerId: string,
    operation: string,
    context: { importInterface?: string; payload?: JsonValue; idempotencyKey?: string } = {},
  ) {
    const provider = this.#requireProvider(providerId);
    const implementation = provider.exports?.["*"]?.[operation];
    if (!(implementation instanceof Function)) {
      throw new Error(`wrpc.operation_not_found: ${providerId}.${operation}`);
    }

    if (provider.inFlight >= provider.maxInFlight) {
      const error = new MembraneOverloadedError({
        providerId,
        operation,
        importInterface: context.importInterface,
        maxInFlight: provider.maxInFlight,
        inFlight: provider.inFlight,
      });
      this.events.push({
        type: "link.Rejected",
        providerId,
        operation,
        importInterface: context.importInterface,
        membrane: "overloaded",
        failureClass: error.failure.class,
        maxInFlight: provider.maxInFlight,
        inFlight: provider.inFlight,
        idempotencyKey: context.idempotencyKey,
      });
      throw error;
    }

    provider.inFlight += 1;
    provider.callsStarted += 1;
    this.events.push({
      type: "link.Called",
      componentId: "",
      importInterface: context.importInterface ?? "",
      providerId,
      exportInterface: "*",
      operation,
      transport: "in-process",
      boundaryMode: "live",
      deadline: null,
      outcome: "ok",
      failureClass: null,
      cancellation: "not-needed",
      codec: this.codec.name,
      idempotencyKey: context.idempotencyKey,
      inFlight: provider.inFlight,
    });

    try {
      return await implementation(context.payload ?? {}, {
        componentId: "",
        importInterface: context.importInterface ?? "",
        operation,
        deadline: null,
        signal: new AbortController().signal,
        sleep: (durationMs) => this.clock.sleep(durationMs),
        callLinked: () => Promise.reject(new Error("callLinked unsupported on callProvider")),
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

  providerRpcAttempt(args: { providerId: string; operation: string; idempotencyKey: string }) {
    const key = [args.providerId, args.operation, args.idempotencyKey].join("\0");
    const count = (this.#providerRpcAttempts.get(key) ?? 0) + 1;
    this.#providerRpcAttempts.set(key, count);
    return Object.freeze({ key, count });
  }

  report() {
    const providers: Record<
      string,
      { maxInFlight: number; inFlight: number; callsStarted: number }
    > = {};
    for (const [id, provider] of this.#providers) {
      providers[id] = {
        maxInFlight: provider.maxInFlight,
        inFlight: provider.inFlight,
        callsStarted: provider.callsStarted,
      };
    }

    return Object.freeze({
      contract: MEMBRANE_CONTRACT_VERSION,
      issue: "HOBO-598",
      providers,
      events: structuredClone(this.events),
    });
  }

  #requireComponent(componentId: string) {
    const component = this.#components.get(componentId);
    if (!component) {
      throw new Error(`wrpc.component_not_registered: ${componentId}`);
    }
    return component;
  }

  #requireProvider(providerId: string) {
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw new Error(`wrpc.provider_not_registered: ${providerId}`);
    }
    return provider;
  }
}

type EstablishedLink = {
  componentId: string;
  importInterface: string;
  providerId: string;
  exportInterface: string;
  transport: "in-process";
  boundaryMode: "live";
};

function linkKey(componentId: string, importInterface: string) {
  return `${componentId}\0${importInterface}`;
}

function assertId(id: string, kind: string) {
  if (!isJsonString(id) || id.length === 0) {
    throw new Error(`wrpc.${kind}_id_required`);
  }
}

function normalizeNonNegativeInteger(value: number, fieldName: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function isMembraneFailure(
  error: JsonValue,
): error is MembraneOverloadedError | MembraneSeveredError | AmbiguousReturnError {
  return (
    error instanceof MembraneOverloadedError ||
    error instanceof MembraneSeveredError ||
    error instanceof AmbiguousReturnError
  );
}

function toFailureEvent(
  type: "link.Failed",
  error: MembraneOverloadedError | MembraneSeveredError | AmbiguousReturnError,
  context: { importInterface?: string; idempotencyKey?: string },
): LinkFailedEvent {
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

export {
  AmbiguousReturnError,
  DeadlineExceededError,
  MembraneOverloadedError,
  MembraneSeveredError,
};
