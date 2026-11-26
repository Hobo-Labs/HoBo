import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createBuiltInDeliveryAdapter,
  createBuiltInExperimentAdapter,
  createFlaggerDeliveryAdapter,
  createGrowthBookExperimentAdapter,
  createMinimalDeliveryAdapter,
  createNonConformantCDEventsDeliveryAdapter,
  createRebucketingExperimentAdapter,
  createRollbackDroppingDeliveryAdapter,
  runDeliveryAdapterConformance,
  runDeliveryCapabilityDegradationCheck,
  runExperimentAdapterConformance,
  selectHarnessAdapters,
} from "../src/harness-adapter-conformance.js";

test("built-in and external delivery adapters pass the identical delivery conformance suite", () => {
  const reports = [
    runDeliveryAdapterConformance({
      adapterName: "hobo-built-in-delivery",
      createAdapter: createBuiltInDeliveryAdapter,
    }),
    runDeliveryAdapterConformance({
      adapterName: "flagger",
      createAdapter: createFlaggerDeliveryAdapter,
    }),
  ];

  assert.deepEqual(
    reports.map((report) => report.checks.map((check) => check.name)),
    [
      [
        "rollout-started-stepped-promoted",
        "rollout-rollback-verdict-honored",
        "rollout-cdevents-roundtrip",
      ],
      [
        "rollout-started-stepped-promoted",
        "rollout-rollback-verdict-honored",
        "rollout-cdevents-roundtrip",
      ],
    ],
  );
  assert.deepEqual(reports.map((report) => report.status), ["passed", "passed"]);
});

test("built-in and external experiment adapters pass the identical experiment conformance suite", () => {
  const reports = [
    runExperimentAdapterConformance({
      adapterName: "hobo-built-in-experiment",
      createAdapter: createBuiltInExperimentAdapter,
    }),
    runExperimentAdapterConformance({
      adapterName: "growthbook",
      createAdapter: createGrowthBookExperimentAdapter,
    }),
  ];

  assert.deepEqual(
    reports.map((report) => report.checks.map((check) => check.name)),
    [
      [
        "deterministic-assignment",
        "idempotent-exposure",
        "concluded-verdict",
      ],
      [
        "deterministic-assignment",
        "idempotent-exposure",
        "concluded-verdict",
      ],
    ],
  );
  assert.deepEqual(reports.map((report) => report.status), ["passed", "passed"]);
});

test("missing delivery capability degrades with a warning instead of panicking", () => {
  const report = runDeliveryCapabilityDegradationCheck({
    adapterName: "minimal-delivery",
    createAdapter: createMinimalDeliveryAdapter,
  });

  assert.equal(report.status, "passed");
  assert.deepEqual(report.warnings.map((warning) => warning.missingCapability), [
    "blue-green",
    "automated-rollback",
  ]);
});

test("camp adapter selection is a Matching change with no app-code change", () => {
  const builtIn = selectHarnessAdapters({
    camp: "prod-us",
    appCodeDigest: "sha256:app-code",
    deliveryAdapter: "hobo-built-in-delivery",
    experimentAdapter: "hobo-built-in-experiment",
  });
  const external = selectHarnessAdapters({
    camp: "prod-us",
    appCodeDigest: "sha256:app-code",
    deliveryAdapter: "flagger",
    experimentAdapter: "growthbook",
  });

  assert.deepEqual(builtIn.appCodeDigest, external.appCodeDigest);
  assert.deepEqual(builtIn.camp, external.camp);
  assert.notDeepEqual(builtIn.matching.deliveryAdapter, external.matching.deliveryAdapter);
  assert.notDeepEqual(builtIn.matching.experimentAdapter, external.matching.experimentAdapter);
});

test("non-conformant rollout CDEvents fail the delivery suite", () => {
  assert.throws(
    () =>
      runDeliveryAdapterConformance({
        adapterName: "bad-cdevents",
        createAdapter: createNonConformantCDEventsDeliveryAdapter,
      }),
    /rollout event source must be hobo:delivery/,
  );
});

test("delivery suite catches an adapter that silently drops rollback verdicts", () => {
  assert.throws(
    () =>
      runDeliveryAdapterConformance({
        adapterName: "drops-rollback",
        createAdapter: createRollbackDroppingDeliveryAdapter,
      }),
    /rollback verdict was not emitted/,
  );
});

test("experiment suite catches rebucketing of an already-assigned subject", () => {
  assert.throws(
    () =>
      runExperimentAdapterConformance({
        adapterName: "rebucketing",
        createAdapter: createRebucketingExperimentAdapter,
      }),
    /sticky assignment changed for subject user_123/,
  );
});
