import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createOpenExperimentRuntime,
  projectExposureStream
} from "../src/openexperiment-runtime-data.js";

const TRACE_ID = "11111111111111111111111111111111";
const TRACEPARENT = `00-${TRACE_ID}-00000000000000aa-01`;

const subject = Object.freeze({
  kind: "user",
  id: "user_123",
  tenant: "tenant_a"
});

const evaluationContext = Object.freeze({
  targetingKey: "tenant_a:user_123",
  user: subject,
  identity: {
    kind: "service",
    id: "spiffe://tenant-a/camp/prod/bindle/checkout",
    tenant: "tenant_a"
  },
  attributes: [{ key: "plan", value: "pro" }]
});

function checkoutExperiment(overrides = {}) {
  return {
    key: "checkout-copy",
    flagKey: "checkout-copy-experiment",
    allocationSeq: 1,
    sampleRatioBasisPoints: 10000,
    variants: [
      { key: "control", flagVariant: "control", allocationBasisPoints: 5000 },
      { key: "treatment", flagVariant: "short-copy", allocationBasisPoints: 5000 }
    ],
    metricRefs: [
      {
        name: "checkout.completed",
        source: "otel://meter/checkout",
        role: "primary"
      },
      {
        name: "checkout.error_rate",
        source: "otel://meter/checkout",
        role: "guardrail"
      }
    ],
    ...overrides
  };
}

test("assignment is deterministic for a fixed experiment and subject", () => {
  const left = createOpenExperimentRuntime().assign(checkoutExperiment(), {
    evaluationContext,
    traceparent: TRACEPARENT
  });
  const right = createOpenExperimentRuntime().assign(checkoutExperiment(), {
    evaluationContext,
    traceparent: TRACEPARENT
  });

  assert.equal(left.assignment.variantKey, right.assignment.variantKey);
  assert.equal(left.assignment.bucket, right.assignment.bucket);
  assert.equal(left.assignment.subjectKey, "tenant_a:user_123");
  assert.equal(left.event.type, "experiment.Assigned");
});

test("first assignment pins the subject for the experiment lifetime", () => {
  const runtime = createOpenExperimentRuntime();
  const original = checkoutExperiment({
    variants: [
      { key: "control", flagVariant: "control", allocationBasisPoints: 10000 },
      { key: "treatment", flagVariant: "short-copy", allocationBasisPoints: 0 }
    ]
  });
  const reallocated = checkoutExperiment({
    allocationSeq: 2,
    variants: [
      { key: "control", flagVariant: "control", allocationBasisPoints: 0 },
      { key: "treatment", flagVariant: "short-copy", allocationBasisPoints: 10000 }
    ]
  });

  const first = runtime.assign(original, { evaluationContext, traceparent: TRACEPARENT });
  const afterAllocationChange = runtime.assign(reallocated, {
    evaluationContext,
    traceparent: TRACEPARENT
  });

  assert.equal(first.assignment.variantKey, "control");
  assert.equal(afterAllocationChange.assignment.variantKey, "control");
  assert.equal(afterAllocationChange.assignment.pinned, true);
  assert.equal(afterAllocationChange.assignment.allocationSeq, 1);
  assert.equal(runtime.events().filter((event) => event.type === "experiment.Assigned").length, 1);
});

test("exposure is recorded only when the variant affects behavior", () => {
  const runtime = createOpenExperimentRuntime();
  const { assignment } = runtime.assign(checkoutExperiment(), {
    evaluationContext,
    traceparent: TRACEPARENT
  });

  const skipped = runtime.recordExposure(assignment, {
    influenced: false,
    traceparent: TRACEPARENT
  });
  const recorded = runtime.recordExposure(assignment, {
    influenced: true,
    traceparent: TRACEPARENT
  });

  assert.deepEqual(skipped, { emitted: false, reason: "variant-not-used" });
  assert.equal(recorded.emitted, true);
  assert.equal(recorded.event.type, "experiment.Exposed");
  assert.equal(runtime.events().filter((event) => event.type === "experiment.Exposed").length, 1);
});

test("assignment and exposure events carry sampling markers and OTEL joins", () => {
  const runtime = createOpenExperimentRuntime();
  const { assignment, event: assignedEvent } = runtime.assign(checkoutExperiment(), {
    evaluationContext,
    traceparent: TRACEPARENT
  });
  const { event: exposedEvent } = runtime.recordExposure(assignment, {
    influenced: true,
    traceparent: TRACEPARENT
  });

  assert.equal(assignedEvent.data.sampling.population, "sampled");
  assert.equal(assignedEvent.data.sampling.rateBasisPoints, 10000);
  assert.equal(assignedEvent.data.trace.traceId, TRACE_ID);
  assert.equal(exposedEvent.data.sampling.population, "sampled");
  assert.equal(exposedEvent.data.trace.traceId, TRACE_ID);
  assert.deepEqual(
    exposedEvent.data.metricRefs.map((metricRef) => [
      metricRef.name,
      metricRef.source,
      metricRef.traceId,
      metricRef.eventId
    ]),
    [
      ["checkout.completed", "otel://meter/checkout", TRACE_ID, exposedEvent.id],
      ["checkout.error_rate", "otel://meter/checkout", TRACE_ID, exposedEvent.id]
    ]
  );
});

test("exposure is idempotent per subject and experiment", () => {
  const runtime = createOpenExperimentRuntime();
  const { assignment } = runtime.assign(checkoutExperiment(), {
    evaluationContext,
    traceparent: TRACEPARENT
  });
  const first = runtime.recordExposure(assignment, {
    influenced: true,
    traceparent: TRACEPARENT
  });
  const duplicate = runtime.recordExposure(assignment, {
    influenced: true,
    traceparent: TRACEPARENT
  });

  assert.equal(first.emitted, true);
  assert.equal(duplicate.emitted, false);
  assert.equal(duplicate.reason, "already-exposed");
  assert.equal(duplicate.event.id, first.event.id);
  assert.equal(runtime.events().filter((event) => event.type === "experiment.Exposed").length, 1);
});

test("sampled exposure streams cannot be consumed as full traffic", () => {
  const runtime = createOpenExperimentRuntime();
  const { assignment } = runtime.assign(checkoutExperiment(), {
    evaluationContext,
    traceparent: TRACEPARENT
  });
  runtime.recordExposure(assignment, {
    influenced: true,
    traceparent: TRACEPARENT
  });

  assert.equal(projectExposureStream(runtime.events(), { traffic: "sampled" }).length, 1);
  assert.throws(
    () => projectExposureStream(runtime.events(), { traffic: "full" }),
    (error) =>
      error.code === "sampled-stream-not-full" &&
      /sampled exposure stream cannot be read as full traffic/.test(error.message)
  );
  assert.throws(
    () => projectExposureStream([{ type: "experiment.Exposed", data: {} }], { traffic: "full" }),
    /sampled exposure stream cannot be read as full traffic/
  );
});
