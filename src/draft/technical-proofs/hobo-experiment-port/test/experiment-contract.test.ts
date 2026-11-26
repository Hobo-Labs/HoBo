import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import {
  assign,
  conclude,
  createExperimentEvent,
  recordExposure,
  roundTripDefinition,
  validateExperimentDefinition
} from "../src/experiment-contract.js";

const root = join(import.meta.dirname, "..");

function checkoutDefinition(overrides = {}) {
  return {
    key: "checkout-copy",
    flagKey: "checkout-variant",
    sampleRatioBasisPoints: 10000,
    variants: [
      { key: "control", allocationBasisPoints: 5000, flagVariant: "control" },
      { key: "treatment", allocationBasisPoints: 5000, flagVariant: "short-copy" }
    ],
    metrics: [
      {
        name: "checkout.completed",
        kind: "counter",
        source: "otel://meter/checkout",
        primary: true,
        guardrail: false
      },
      {
        name: "checkout.error_rate",
        kind: "ratio",
        source: "otel://meter/checkout",
        primary: false,
        guardrail: true
      }
    ],
    ...overrides
  };
}

const subject = Object.freeze({
  kind: "user",
  id: "user_123",
  tenant: "tenant_a"
});

test("jco generates typed OpenExperiment provider bindings", async () => {
  const provider = await readFile(
    join(root, "generated", "interfaces", "hobo-experiment-provider.d.ts"),
    "utf8"
  );
  const types = await readFile(
    join(root, "generated", "interfaces", "hobo-experiment-types.d.ts"),
    "utf8"
  );

  assert.match(provider, /assign\(/);
  assert.match(provider, /recordExposure\(/);
  assert.match(provider, /conclude\(/);
  assert.match(provider, /ExperimentError/);
  assert.match(types, /ExperimentDefinition/);
  assert.match(types, /AnalysisResult/);
  assert.match(types, /ExperimentError/);
  assert.match(types, /sampled: boolean/);
});

test("experiment definition with variants and metrics round-trips", () => {
  const definition = checkoutDefinition();

  assert.deepEqual(roundTripDefinition(definition), definition);
  assert.doesNotThrow(() => validateExperimentDefinition(definition));
});

test("assignment, exposure, and conclusion events preserve sampled markers", () => {
  const definition = checkoutDefinition();
  const assignment = assign(definition, {
    experimentKey: "checkout-copy",
    subject,
    contextHash: "ctx:subject:123"
  });
  const exposure = recordExposure(assignment, { occurredAt: "2026-06-25T02:00:00.000Z" });
  const conclusion = conclude(definition, {
    verdict: "promote",
    winningVariant: assignment.variantKey,
    confidence: 0.97,
    reason: "primary metric improved and guardrail held"
  });

  assert.equal(assignment.sampled, true);
  assert.equal(exposure.sampled, true);
  assert.deepEqual(
    [
      createExperimentEvent("experiment.Assigned", assignment),
      createExperimentEvent("experiment.Exposed", exposure),
      createExperimentEvent("experiment.Concluded", conclusion)
    ].map((event) => [event.type, event.data.sampled]),
    [
      ["experiment.Assigned", true],
      ["experiment.Exposed", true],
      ["experiment.Concluded", undefined]
    ]
  );
});

test("assignment sampling marker follows the definition sample ratio", () => {
  const assignment = assign(checkoutDefinition({ sampleRatioBasisPoints: 5000 }), {
    experimentKey: "checkout-copy",
    subject,
    contextHash: "ctx:subject:123"
  });

  assert.equal(assignment.sampled, false);
});

test("variant allocations above 100 percent are rejected", () => {
  assert.throws(
    () =>
      validateExperimentDefinition(
        checkoutDefinition({
          variants: [
            { key: "control", allocationBasisPoints: 8000, flagVariant: "control" },
            { key: "treatment", allocationBasisPoints: 3000, flagVariant: "short-copy" }
          ]
        })
      ),
    /variant allocations exceed 100 percent/
  );
});

test("experiment events reject missing sampled markers on sampled event families", () => {
  assert.throws(
    () =>
      createExperimentEvent("experiment.Assigned", {
        experimentKey: "checkout-copy",
        subject,
        variantKey: "control"
      }),
    /experiment.Assigned requires sampled marker/
  );

  assert.throws(
    () =>
      createExperimentEvent("experiment.Exposed", {
        experimentKey: "checkout-copy",
        subject,
        variantKey: "control"
      }),
    /experiment.Exposed requires sampled marker/
  );
});

test("exposure for an unassigned subject is a typed error", () => {
  const assignment = assign(checkoutDefinition(), {
    experimentKey: "checkout-copy",
    subject,
    contextHash: "ctx:subject:123"
  });

  assert.throws(
    () =>
      recordExposure(assignment, {
        subject: { kind: "user", id: "user_456", tenant: "tenant_a" },
        occurredAt: "2026-06-25T02:00:00.000Z"
      }),
    (error) =>
      error.code === "unassigned-subject" &&
      /experiment.Exposed subject must match assignment/.test(error.message)
  );
});
