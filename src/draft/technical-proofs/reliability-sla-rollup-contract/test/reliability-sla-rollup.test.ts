import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CONTRACT_VERSION,
  evaluateRestoreDrill,
  foldReliabilityRollup,
  ratifyReliabilityTargets,
  rollbackRollupMutation,
} from "../src/reliability-sla-rollup.js";

const GOLDEN_EVIDENCE = {
  sloSources: {
    "control-plane-availability": { port: "slo-engine", window: "30d" },
    "deploy-resume-after-node-loss": { port: "slo-engine", window: "7d" },
    "rpo-sync-quorum": { port: "slo-engine", window: "24h" },
    "rpo-async-tier": { port: "slo-engine", window: "24h" },
    "rto-full-yard-rebuild": { port: "slo-engine", window: "dr-drill" },
  },
  availabilityView: {
    "control-plane-availability-single-region": {
      estimatedAvailability: 0.9992,
      declaredFailureDomains: ["aws-us-east-1"],
    },
    "control-plane-availability-multi-region": {
      estimatedAvailability: 0.9991,
      declaredFailureDomains: ["aws-us-east-1"],
    },
  },
  restoreDrill: {
    measuredSeconds: 612,
    targetSeconds: 900,
    replayedEvents: 1_250_000,
    minProductionEvents: 1_000_000,
  },
};

test("ratifies built-in reliability targets as measured SLO assertions and marks impossible targets provisional", () => {
  const targets = ratifyReliabilityTargets(GOLDEN_EVIDENCE);

  assert.equal(targets.contract, CONTRACT_VERSION);
  assert.deepEqual(
    targets.items.map((target) => target.id),
    [
      "control-plane-availability-single-region",
      "control-plane-availability-multi-region",
      "deploy-resume-after-node-loss",
      "rpo-sync-quorum",
      "rpo-async-tier",
      "rto-full-yard-rebuild",
    ],
  );

  const ratified = targets.items.filter((target) => target.ratification === "ratified");
  assert.ok(ratified.length > 0);
  assert.ok(
    ratified.every((target) => target.assertion.measuredBy === "slo-engine"),
    "ratified targets must be asserted through the SLO engine",
  );

  const multiRegion = targets.items.find((target) => target.id === "control-plane-availability-multi-region");
  assert.equal(multiRegion.ratification, "provisional");
  assert.deepEqual(multiRegion.warnings, [
    "availability-estimate-below-objective",
    "multi-region-target-has-undeclared-shared-failure-domain",
  ]);
});

test("DR replay drill checks the RTO target and rejects CI-scale false passes", () => {
  assert.deepEqual(
    evaluateRestoreDrill({
      measuredSeconds: 612,
      targetSeconds: 900,
      replayedEvents: 1_250_000,
      minProductionEvents: 1_000_000,
    }),
    {
      ok: true,
      status: "passed",
      measuredSeconds: 612,
      targetSeconds: 900,
      productionScale: true,
      reason: null,
    },
  );

  assert.deepEqual(
    evaluateRestoreDrill({
      measuredSeconds: 90,
      targetSeconds: 900,
      replayedEvents: 2_000,
      minProductionEvents: 1_000_000,
    }),
    {
      ok: false,
      status: "provisional",
      measuredSeconds: 90,
      targetSeconds: 900,
      productionScale: false,
      reason: "restore-drill-not-production-scale",
    },
  );

  assert.deepEqual(
    evaluateRestoreDrill({
      measuredSeconds: 901,
      targetSeconds: 900,
      replayedEvents: 1_250_000,
      minProductionEvents: 1_000_000,
    }).status,
    "breached",
  );
});

test("status rollup shows observed SLO next to AvailabilityView estimate and derives target breaches as incidents", () => {
  const rollup = foldReliabilityRollup([
    event(1, "sla.TargetRatified", {
      project: "shop",
      environment: "prod",
      targetId: "control-plane-availability-single-region",
      objective: 0.999,
    }),
    event(2, "availability.Estimated", {
      project: "shop",
      environment: "prod",
      targetId: "control-plane-availability-single-region",
      estimatedAvailability: 0.9992,
      estimatedAnnualDowntimeMinutes: 420.5,
      weakestLinkPath: ["gateway", "api", "primary-db"],
    }),
    event(3, "slo.Measured", {
      project: "shop",
      environment: "prod",
      targetId: "control-plane-availability-single-region",
      observedAvailability: 0.9986,
      window: "30d",
      fresh: true,
    }),
  ]);

  assert.equal(rollup.contract, CONTRACT_VERSION);
  assert.equal(rollup.environments.prod.status, "degraded");
  assert.equal(rollup.environments.prod.targets["control-plane-availability-single-region"].observedAvailability, 0.9986);
  assert.equal(rollup.environments.prod.targets["control-plane-availability-single-region"].estimatedAvailability, 0.9992);
  assert.deepEqual(rollup.environments.prod.incidents, [
    {
      id: "incident-evt-3",
      class: "sla-target-breach",
      component: "control-plane-availability-single-region",
      targetId: "control-plane-availability-single-region",
      tenantScoped: false,
    },
  ]);
});

test("status page never renders green when a scoped component burns or the read is stale", () => {
  const tenantBurn = foldReliabilityRollup([
    event(1, "slo.Measured", {
      project: "shop",
      environment: "prod",
      targetId: "checkout-availability",
      observedAvailability: 0.9995,
      window: "30d",
      fresh: true,
    }),
    event(2, "incident.Opened", {
      project: "shop",
      environment: "prod",
      class: "tenant-scoped-slo-breach",
      component: "checkout",
      targetId: "checkout-availability",
      tenantScoped: true,
    }),
  ]);
  assert.equal(tenantBurn.statusPage.prod.publicStatus, "degraded");

  const stale = foldReliabilityRollup([
    event(1, "slo.Measured", {
      project: "shop",
      environment: "prod",
      targetId: "api-availability",
      observedAvailability: 1,
      window: "30d",
      fresh: false,
    }),
  ]);
  assert.equal(stale.statusPage.prod.publicStatus, "delayed/unknown");
});

test("rollup replay is deterministic from events only and public status mutations are reversible", () => {
  const events = [
    event(2, "slo.Measured", {
      project: "shop",
      environment: "prod",
      targetId: "api-availability",
      observedAvailability: 0.9999,
      window: "30d",
      fresh: true,
    }),
    event(1, "statuspage.Published", {
      project: "shop",
      environment: "prod",
      allowlist: ["API"],
      redactionProfile: "public-status-v1",
      contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
  ];

  const live = foldReliabilityRollup(events);
  const replayed = foldReliabilityRollup([...events].reverse());
  assert.deepEqual(replayed, live);
  assert.deepEqual(rollbackRollupMutation(events[1]), {
    id: "revert-evt-1",
    seq: 2,
    type: "statuspage.Unpublished",
    reverts: "evt-1",
    data: {
      project: "shop",
      environment: "prod",
    },
  });
});

function event(seq, type, data) {
  return {
    id: `evt-${seq}`,
    seq,
    type,
    time: `2026-06-2${seq}T00:00:00.000Z`,
    data,
  };
}
