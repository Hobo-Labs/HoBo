import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createTraceContextRuntime,
  isTraceparent,
  TRACE_CONTEXT_CONTRACT,
} from "../src/trace-context-propagation.js";

const ACTOR = { kind: "system", id: "gateway" };

function envelope(overrides = {}) {
  return {
    id: overrides.id ?? "cmd-1",
    type: overrides.type ?? "deployment.Commanded",
    v: 1,
    streamId: overrides.streamId ?? "deployment:example",
    seq: overrides.seq ?? 1,
    ts: overrides.ts ?? "2026-06-25T16:00:00.000Z",
    actor: ACTOR,
    tenant: overrides.tenant ?? "tenant-a",
    correlationId: overrides.correlationId ?? "deploy-1",
    data: overrides.data ?? {},
    meta: overrides.meta ?? {},
  };
}

describe("trace-context propagation contract", () => {
  it("synthesizes a W3C root traceparent for ingress without one", () => {
    const runtime = createTraceContextRuntime({
      traceIds: ["11111111111111111111111111111111"],
      spanIds: ["2222222222222222"],
      clock: ["2026-06-25T16:00:00.000Z", "2026-06-25T16:00:00.010Z"],
    });

    const prepared = runtime.prepareIngressEnvelope(envelope(), "gateway.request");

    assert.equal(TRACE_CONTEXT_CONTRACT, "hobo.trace-context/v1");
    assert.ok(isTraceparent(prepared.meta.traceparent));
    assert.equal(
      prepared.meta.traceparent,
      "00-11111111111111111111111111111111-2222222222222222-01",
    );
    assert.equal(prepared.meta.traceRepair, "synthesized-root");
    assert.deepEqual(runtime.spans(), [
      {
        name: "gateway.request",
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        parentSpanId: null,
        causationId: "cmd-1",
        correlationId: "deploy-1",
        startedAt: "2026-06-25T16:00:00.000Z",
        endedAt: "2026-06-25T16:00:00.010Z",
        attributes: { envelopeType: "deployment.Commanded" },
      },
    ]);
  });

  it("propagates one trace across command, step span, and child command", () => {
    const runtime = createTraceContextRuntime({
      spanIds: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
      clock: [
        "2026-06-25T16:00:00.000Z",
        "2026-06-25T16:00:00.020Z",
        "2026-06-25T16:00:00.030Z",
        "2026-06-25T16:00:00.050Z",
      ],
    });
    const root = envelope({
      meta: {
        traceparent: "00-33333333333333333333333333333333-9999999999999999-01",
      },
    });

    const childResult = runtime.withSpan(root, "step.plan", { step: "plan" }, (stepEnvelope) =>
      runtime.createChildCommand(stepEnvelope, {
        id: "cmd-2",
        type: "resource.PlanRequested",
        streamId: "resource:api",
        seq: 1,
      }),
    );

    assert.equal(
      childResult.meta.traceparent,
      "00-33333333333333333333333333333333-aaaaaaaaaaaaaaaa-01",
    );
    assert.equal(childResult.causationId, "cmd-1");
    assert.equal(childResult.correlationId, "deploy-1");

    const spans = runtime.spans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].traceId, "33333333333333333333333333333333");
    assert.equal(spans[0].parentSpanId, "9999999999999999");
    assert.equal(spans[0].causationId, "cmd-1");
    assert.equal(spans[0].correlationId, "deploy-1");
  });

  it("preserves a valid incoming trace id and records gateway as its child span", () => {
    const runtime = createTraceContextRuntime({
      spanIds: ["6666666666666666"],
      clock: ["2026-06-25T16:00:00.000Z", "2026-06-25T16:00:00.005Z"],
    });
    const prepared = runtime.prepareIngressEnvelope(
      envelope({
        meta: {
          traceparent: "00-44444444444444444444444444444444-5555555555555555-01",
        },
      }),
      "gateway.request",
    );

    assert.equal(
      prepared.meta.traceparent,
      "00-44444444444444444444444444444444-6666666666666666-01",
    );
    assert.equal(prepared.meta.traceRepair, undefined);
    assert.equal(runtime.spans()[0].spanId, "6666666666666666");
    assert.equal(runtime.spans()[0].parentSpanId, "5555555555555555");
  });

  it("keeps fan-out sibling spans under the same parent span", () => {
    const runtime = createTraceContextRuntime({
      spanIds: ["1111111111111111", "2222222222222222"],
    });
    const parent = envelope({
      meta: {
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-9999999999999999-01",
      },
    });

    const left = runtime.withSpan(parent, "actor.left", {}, (spanEnvelope) => spanEnvelope);
    const right = runtime.withSpan(parent, "actor.right", {}, (spanEnvelope) => spanEnvelope);

    assert.equal(left.meta.traceparent, "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01");
    assert.equal(right.meta.traceparent, "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-2222222222222222-01");
    assert.deepEqual(
      runtime.spans().map((span) => span.parentSpanId),
      ["9999999999999999", "9999999999999999"],
    );
  });

  it("preserves trace context across an async queue hop", () => {
    const runtime = createTraceContextRuntime();
    const queued = runtime.enqueue(
      envelope({
        meta: {
          traceparent: "00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-1212121212121212-01",
        },
      }),
    );

    const dequeued = runtime.dequeue(queued);

    assert.equal(
      dequeued.meta.traceparent,
      "00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-1212121212121212-01",
    );
  });

  it("rejects queue messages that lost trace context", () => {
    const runtime = createTraceContextRuntime();

    assert.throws(
      () => runtime.dequeue(JSON.stringify(envelope())),
      /envelope\.meta\.traceparent/,
    );
  });

  it("regenerates malformed traceparent values instead of trusting them", () => {
    const runtime = createTraceContextRuntime({
      traceIds: ["cccccccccccccccccccccccccccccccc"],
      spanIds: ["dddddddddddddddd"],
    });

    const prepared = runtime.prepareIngressEnvelope(
      envelope({ meta: { traceparent: "not-a-traceparent" } }),
      "gateway.request",
    );

    assert.equal(
      prepared.meta.traceparent,
      "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
    );
    assert.equal(prepared.meta.traceRepair, "regenerated-malformed-traceparent");
  });

  it("monotonically adjusts a child span when clock skew reports it before its parent", () => {
    const runtime = createTraceContextRuntime({
      spanIds: ["eeeeeeeeeeeeeeee"],
      clock: ["2026-06-25T16:00:01.000Z", "2026-06-25T16:00:00.500Z"],
    });

    runtime.withSpan(
      envelope({
        meta: {
          traceparent: "00-dddddddddddddddddddddddddddddddd-3434343434343434-01",
        },
      }),
      "actor.message",
      {},
      () => "ok",
    );

    assert.equal(runtime.spans()[0].startedAt, "2026-06-25T16:00:01.000Z");
    assert.equal(runtime.spans()[0].endedAt, "2026-06-25T16:00:01.000Z");
    assert.equal(runtime.spans()[0].clockSkewAdjusted, true);
  });
});
