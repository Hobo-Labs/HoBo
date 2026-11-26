import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createRuntimeLocalEventStore } from "../../camp-eventstore-runtime-port-contract/src/camp-eventstore-runtime-port.js";
import {
  AmbiguousReturnError,
  MembraneOverloadedError,
  MembraneSeveredError,
  createMembraneFailureContract,
  reconcileAmbiguousFailure,
  runMembraneFailureConformance,
} from "../src/wrpc-membrane-failure.js";

describe("wRPC membrane failure contract", () => {
  it("sheds a saturated provider with typed overloaded instead of unbounded queuing", async () => {
    const membrane = createMembraneFailureContract();
    membrane.registerProvider({
      id: "kv",
      maxInFlight: 1,
      operations: {
        async get() {
          await never();
        },
      },
    });

    const first = membrane.callProvider("kv", "get", {
      importInterface: "wasi:keyvalue/store.get",
      idempotencyKey: "read-1",
    });

    await assert.rejects(
      () =>
        membrane.callProvider("kv", "get", {
          importInterface: "wasi:keyvalue/store.get",
          idempotencyKey: "read-2",
        }),
      (error) => {
        assert.ok(error instanceof MembraneOverloadedError);
        assert.equal(error.membrane, "overloaded");
        assert.equal(error.failure.class, "transient");
        assert.equal(error.providerId, "kv");
        return true;
      },
    );

    assert.equal(membrane.report().providers.kv.inFlight, 1);
    assert.deepEqual(membrane.report().events.map((event) => event.type), [
      "link.Called",
      "link.Rejected",
    ]);

    first.catch(() => {});
  });

  it("classifies mid-stream severance as partial failure with idempotency decision required", async () => {
    const membrane = createMembraneFailureContract();
    membrane.registerProvider({
      id: "blob",
      maxInFlight: 1,
      operations: {
        async streamPut() {
          throw new MembraneSeveredError({
            providerId: "blob",
            operation: "streamPut",
            importInterface: "wasi:io/streams.write",
            committed: "unknown",
          });
        },
      },
    });

    await assert.rejects(
      () =>
        membrane.callProvider("blob", "streamPut", {
          importInterface: "wasi:io/streams.write",
          idempotencyKey: "blob-write-1",
        }),
      (error) => {
        assert.ok(error instanceof MembraneSeveredError);
        assert.equal(error.membrane, "severed");
        assert.equal(error.failure.class, "partial-failure");
        assert.equal(error.failure.requiresIdempotencyDecision, true);
        assert.equal(error.failure.strategy.idempotencyRule, "forward-key-or-refresh-before-act");
        return true;
      },
    );
  });

  it("dedups retried EventStore append effects after an ambiguous membrane return", async () => {
    const store = createRuntimeLocalEventStore();
    const call = {
      effectKind: "eventstore-append",
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
    assert.equal((await store.read("orders:42")).length, 1);
  });

  it("retries provider RPC at least once and forwards the idempotency key to the provider", async () => {
    const seen = [];
    const membrane = createMembraneFailureContract();
    membrane.registerProvider({
      id: "payment",
      maxInFlight: 1,
      operations: {
        async charge(_payload, context) {
          seen.push(context.idempotencyKey);
          return { chargeId: `ch-${seen.length}` };
        },
      },
    });

    const call = {
      effectKind: "provider-rpc",
      providerId: "payment",
      operation: "charge",
      importInterface: "payments/charge",
      payload: { cents: 4000 },
      idempotencyKey: "charge-42",
    };

    const first = await reconcileAmbiguousFailure({
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

    assert.equal(first.outcome, "retried-provider-rpc");
    assert.equal(retry.outcome, "provider-idempotency-forwarded");
    assert.deepEqual(seen, ["charge-42", "charge-42"]);
  });

  it("does not amplify retry storms when a provider is already overloaded", async () => {
    const membrane = createMembraneFailureContract();
    membrane.registerProvider({
      id: "mailer",
      maxInFlight: 0,
      operations: {
        async send() {
          throw new Error("should not run while saturated");
        },
      },
    });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        reconcileAmbiguousFailure({
          membrane,
          call: {
            effectKind: "provider-rpc",
            providerId: "mailer",
            operation: "send",
            importInterface: "wasi:messaging/send",
            payload: { index },
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

    assert.equal(outcomes.every((outcome) => outcome.status === "fulfilled"), true);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.value.outcome),
      [
        "shed-overloaded",
        "shed-overloaded",
        "shed-overloaded",
        "shed-overloaded",
        "shed-overloaded",
      ],
    );
    assert.equal(membrane.report().providers.mailer.callsStarted, 0);
  });

  it("publishes a component-host conformance report for HOBO-25 assertions", async () => {
    const report = await runMembraneFailureConformance();

    assert.equal(report.contract, "hobo.wrpc-membrane-failure/v1");
    assert.equal(report.issue, "HOBO-25");
    assert.deepEqual(report.scopeOut, [
      "NATS/JetStream transport implementation",
      "per-provider idempotency implementations",
      "Reactor client coalescing",
    ]);
    assert.deepEqual(report.assertions, {
      boundedBackpressure: "pass",
      severedClassifiedPartial: "pass",
      eventStoreAppendDedup: "pass",
      providerRpcIdempotencyForwarded: "pass",
      retryStormShed: "pass",
    });
  });
});

function never() {
  return new Promise(() => {});
}
