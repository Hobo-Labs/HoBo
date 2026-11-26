import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createRuntimeLocalEventStore } from "../../camp-eventstore-runtime-port-contract/src/camp-eventstore-runtime-port.js";
import {
  AmbiguousReturnError,
  createMembraneDeadlineBackpressure,
  MembraneOverloadedError,
  MembraneSeveredError,
  reconcileAmbiguousFailure,
} from "../src/index.js";

describe("membrane backpressure and ambiguous failure reconciliation", () => {
  it("sheds saturated provider with typed overloaded before provider is invoked", async () => {
    const membrane = createMembraneDeadlineBackpressure();
    membrane.registerProvider({
      id: "kv",
      maxInFlight: 0,
      exports: {
        "*": {
          get: () => ({ value: "should-not-run" }),
        },
      },
    });

    await assert.rejects(
      () =>
        membrane.callProvider("kv", "get", {
          importInterface: "wasi:keyvalue/store.get",
          idempotencyKey: "read-1",
        }),
      (error) => {
        assert.ok(error instanceof MembraneOverloadedError);
        assert.equal(error.failure.class, "transient");
        return true;
      },
    );

    assert.equal(membrane.report().providers.kv.callsStarted, 0);
    assert.equal(membrane.events.some((event) => event.type === "link.Rejected"), true);
  });

  it("classifies mid-stream severance as partial failure with idempotency decision", async () => {
    const error = new MembraneSeveredError({
      providerId: "blob",
      operation: "streamPut",
      importInterface: "wasi:io/streams.write",
      committed: "unknown",
    });

    assert.equal(error.failure.class, "partial-failure");
    assert.equal(error.failure.requiresIdempotencyDecision, true);
  });

  it("dedups retried EventStore append effects after ambiguous return", async () => {
    const store = createRuntimeLocalEventStore();
    const call = {
      effectKind: "eventstore-append" as const,
      streamId: "orders:42",
      expectedSeq: 0,
      event: {
        type: "order.Reserved",
        data: { orderId: "42" },
        meta: { idempotencyKey: "reserve-42" },
      },
    };

    const first = await reconcileAmbiguousFailure({
      call,
      eventStore: store,
      error: new AmbiguousReturnError({
        providerId: "eventstore",
        operation: "append",
        importInterface: "hobo:eventstore.append",
      }),
    });
    const retry = await reconcileAmbiguousFailure({
      call,
      eventStore: store,
      error: new AmbiguousReturnError({
        providerId: "eventstore",
        operation: "append",
        importInterface: "hobo:eventstore.append",
      }),
    });

    assert.equal(first.outcome, "appended-once");
    assert.equal(retry.outcome, "deduped-eventstore-effect");
  });

  it("forwards idempotency key on provider RPC reconciliation retry", async () => {
    const seen: string[] = [];
    const membrane = createMembraneDeadlineBackpressure();
    membrane.registerProvider({
      id: "payment",
      maxInFlight: 1,
      exports: {
        "*": {
          charge: (_payload, context) => {
            seen.push(context.idempotencyKey ?? "");
            return { chargeId: `ch-${seen.length}` };
          },
        },
      },
    });

    const call = {
      effectKind: "provider-rpc" as const,
      providerId: "payment",
      operation: "charge",
      importInterface: "payments/charge",
      idempotencyKey: "charge-42",
    };

    await reconcileAmbiguousFailure({
      call,
      membrane,
      error: new AmbiguousReturnError({
        providerId: "payment",
        operation: "charge",
        importInterface: "payments/charge",
      }),
    });
    const retry = await reconcileAmbiguousFailure({
      call,
      membrane,
      error: new AmbiguousReturnError({
        providerId: "payment",
        operation: "charge",
        importInterface: "payments/charge",
      }),
    });

    assert.equal(retry.outcome, "provider-idempotency-forwarded");
    assert.deepEqual(seen, ["charge-42", "charge-42"]);
  });

  it("sheds retry storm when provider is already overloaded", async () => {
    const membrane = createMembraneDeadlineBackpressure();
    membrane.registerProvider({
      id: "mailer",
      maxInFlight: 0,
      exports: {
        "*": {
          send: () => {
            throw new Error("should not run while saturated");
          },
        },
      },
    });

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        reconcileAmbiguousFailure({
          membrane,
          call: {
            effectKind: "provider-rpc",
            providerId: "mailer",
            operation: "send",
            importInterface: "wasi:messaging/send",
            idempotencyKey: `mail-${index}`,
          },
          error: new AmbiguousReturnError({
            providerId: "mailer",
            operation: "send",
            importInterface: "wasi:messaging/send",
          }),
        }),
      ),
    );

    assert.ok(outcomes.every((outcome) => outcome.outcome === "shed-overloaded"));
    assert.equal(membrane.report().providers.mailer.callsStarted, 0);
  });
});
