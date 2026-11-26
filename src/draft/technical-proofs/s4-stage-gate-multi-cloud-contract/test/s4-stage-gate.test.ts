import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createS4StageGateEvidence,
  runS4StageGateDrill,
  verifyS4StageGate,
} from "../src/s4-stage-gate.js";

test("S4 stage gate: same unedited Bindle deploys to AWS and Azure via mapping rules", () => {
  const evidence = createS4StageGateEvidence();
  const report = verifyS4StageGate(evidence);

  assert.equal(report.ok, true);
  assert.deepEqual(report.targetProviders, ["aws", "azure"]);
  assert.equal(new Set(evidence.portability.targets.map((target) => target.bindleDigest)).size, 1);
  assert.equal(report.events[0].type, "s4StageGate.DrillPassed");
});

test("S4 stage gate: cross-cloud services connect over SVID-keyed mTLS", () => {
  const evidence = createS4StageGateEvidence();

  assert.equal(evidence.crossCloudMtls.connection.ok, true);
  assert.equal(
    evidence.crossCloudMtls.clientSpiffeId,
    "spiffe://yard/acme/multi-cloud-shop/worker-azure",
  );
  assert.equal(
    evidence.crossCloudMtls.serverSpiffeId,
    "spiffe://yard/acme/multi-cloud-shop/api-aws",
  );
  assert.equal(evidence.crossCloudMtls.edge.auth, "svid-mtls");
  assert.equal(verifyS4StageGate(evidence).ok, true);
});

test("S4 stage gate: unsatisfied require rejects with precise deployment.PlanRejected", () => {
  const evidence = createS4StageGateEvidence();
  const scenario = evidence.portability.negativeScenarios.find((item) => item.kind === "unsatisfied-require");

  assert.deepEqual(scenario.result.event, {
    type: "deployment.PlanRejected",
    reason: "require.unsatisfied",
    missingCapability: "vector-index",
    checkedProviders: ["aws", "azure"],
    detail: "catalog-search requires vector-index; checked aws, azure; no provider satisfies it",
  });
  assert.equal(verifyS4StageGate(evidence).ok, true);
});

test("S4 stage gate: switching orders provider touches only Camp mapping (J3)", () => {
  const evidence = createS4StageGateEvidence();
  const j3 = evidence.j3ProviderSwitch;

  assert.equal(j3.onlyCampMappingChanged, true);
  assert.equal(j3.bindleUnchanged, true);
  assert.equal(j3.before.ordersProvider, "aws");
  assert.equal(j3.after.ordersProvider, "azure");
  assert.deepEqual(j3.after.changedPaths, ["camp.mapping.orders"]);
  assert.equal(j3.before.bindleDigest, j3.after.bindleDigest);
  assert.equal(verifyS4StageGate(evidence).ok, true);
});

test("S4 stage gate: installed pack definition wins matching with match.Decided evidence", () => {
  const evidence = createS4StageGateEvidence();
  const matching = evidence.matchingResolution;

  assert.equal(matching.decision.ok, true);
  assert.equal(matching.decision.winner.id, "pack.postgres.ha.prod");
  assert.equal(matching.event.type, "match.Decided");
  assert.equal(matching.event.data.winner, "pack.postgres.ha.prod");
  assert.equal(matching.installedPack, "@acme/postgres-ha-pack");
  assert.equal(verifyS4StageGate(evidence).ok, true);
});

test("adversarial: cross-cloud mTLS without valid SVID session fails the drill", () => {
  const evidence = createS4StageGateEvidence({
    crossCloudMtls: {
      connection: { ok: false, reason: "svid.invalid" },
      edge: {
        from: { provider: "azure", resource: "worker-azure" },
        to: { provider: "aws", resource: "api-aws" },
        auth: "svid-mtls",
      },
    },
  });
  const report = verifyS4StageGate(evidence);

  assert.equal(report.ok, false);
  assert.equal(report.failures[0].code, "mtls.session-failed");
});

test("adversarial: J3 switch that edits Bindle bytes fails closed", () => {
  const evidence = createS4StageGateEvidence();
  const mutated = {
    ...evidence.j3ProviderSwitch,
    after: {
      ...evidence.j3ProviderSwitch.after,
      bindleDigest: "sha256:mutated-bindle",
      changedPaths: ["camp.mapping.orders", "bindle"],
    },
    bindleUnchanged: false,
    onlyCampMappingChanged: false,
  };
  const report = verifyS4StageGate({
    ...evidence,
    j3ProviderSwitch: mutated,
  });

  assert.equal(report.ok, false);
  assert.ok(report.failures.some((failure) => failure.code === "j3.camp-only-violation"));
});

test("adversarial: platform default wins over installed pack when pack match is removed", () => {
  const evidence = createS4StageGateEvidence({
    matchingResolution: {
      installedPack: "@acme/postgres-ha-pack",
      decision: {
        ok: true,
        winner: { id: "platform.database.default" },
      },
      event: {
        type: "match.Decided",
        data: { winner: "platform.database.default" },
      },
    },
  });
  const report = verifyS4StageGate(evidence);

  assert.equal(report.ok, false);
  assert.ok(report.failures.some((failure) => failure.code === "matching.wrong-winner"));
});

test("credentialed camp-tagged drill lane emits green fixture report", () => {
  const run = runS4StageGateDrill({
    phase: "deploy-and-assert",
    runId: "run-645",
  });

  assert.equal(run.ok, true);
  assert.equal(run.fixture, "examples/multi-cloud-shop");
  assert.deepEqual(run.providers, ["aws", "azure"]);
  assert.equal(run.acceptanceRecord, "docs/design/proofs/s4-01-stage-gate-acceptance");
  assert.equal(run.report.events[0].type, "s4StageGate.DrillPassed");
});
