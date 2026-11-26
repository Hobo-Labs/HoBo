import { classifyFailure } from "./failure-taxonomy.js";
import { MembraneOverloadedError } from "./errors.js";
import type { MembraneDeadlineBackpressure } from "./membrane.js";
import { isJsonString, type JsonValue } from "./json.js";


export interface ReconcileCall {
  effectKind: "eventstore-append" | "provider-rpc";
  streamId?: string;
  expectedSeq?: number;
  event?: {
    type: string;
    data: JsonValue;
    meta: { idempotencyKey: string };
  };
  tenant?: string;
  providerId?: string;
  operation?: string;
  importInterface?: string;
  payload?: JsonValue;
  idempotencyKey?: string;
}

export interface EventStorePort {
  append(
    streamId: string,
    events: Array<{ type: string; data: JsonValue; meta: { idempotencyKey: string } }>,
    options: {
      expectedSeq: number;
      actor: { kind: string; id: string };
      tenant: string;
    },
  ): Promise<{ deduped: JsonValue[]; appended?: JsonValue[] }>;
}

export async function reconcileAmbiguousFailure<TError>(args: {
  call: ReconcileCall;
  eventStore?: EventStorePort;
  membrane?: MembraneDeadlineBackpressure;
  error: TError;
}) {
  const failure = classifyFailure(args.error);
  if (failure.class !== "partial-failure" || failure.requiresIdempotencyDecision !== true) {
    return Object.freeze({
      outcome: "not-ambiguous" as const,
      failure,
    });
  }

  const call = args.call;

  if (call.effectKind === "eventstore-append") {
    if (!args.eventStore) {
      throw new Error("eventStore required for eventstore-append reconciliation");
    }
    const appendResult = await args.eventStore.append(
      requireNonEmptyString(call.streamId, "call.streamId"),
      [call.event!],
      {
        expectedSeq: normalizeNonNegativeInteger(call.expectedSeq ?? 0, "call.expectedSeq"),
        actor: { kind: "system", id: "wrpc-membrane" },
        tenant: call.tenant ?? "conformance-tenant",
      },
    );

    return Object.freeze({
      outcome:
        appendResult.deduped.length > 0
          ? ("deduped-eventstore-effect" as const)
          : ("appended-once" as const),
      failure,
      appendResult,
    });
  }

  if (call.effectKind === "provider-rpc") {
    if (!args.membrane) {
      throw new Error("membrane required for provider-rpc reconciliation");
    }
    try {
      const result = await args.membrane.callProvider(
        requireNonEmptyString(call.providerId, "call.providerId"),
        requireNonEmptyString(call.operation, "call.operation"),
        {
          importInterface: call.importInterface,
          payload: call.payload ?? {},
          idempotencyKey: requireNonEmptyString(call.idempotencyKey, "call.idempotencyKey"),
        },
      );
      const attempt = args.membrane.providerRpcAttempt({
        providerId: call.providerId!,
        operation: call.operation!,
        idempotencyKey: call.idempotencyKey!,
      });

      return Object.freeze({
        outcome:
          attempt.count > 1
            ? ("provider-idempotency-forwarded" as const)
            : ("retried-provider-rpc" as const),
        failure,
        result,
      });
    } catch (caught) {
      if (caught instanceof MembraneOverloadedError) {
        return Object.freeze({
          outcome: "shed-overloaded" as const,
          failure: caught.failure,
          retrySuppressed: true,
        });
      }
      throw caught;
    }
  }

  throw new Error(`unsupported ambiguous failure effect: ${call.effectKind}`);
}

function normalizeNonNegativeInteger(value: number, fieldName: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function requireNonEmptyString(value: JsonValue, fieldName: string) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}
