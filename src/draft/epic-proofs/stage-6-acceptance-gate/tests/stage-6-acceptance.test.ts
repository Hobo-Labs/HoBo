import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import {
  CONTRACT_BOUNDARIES,
  COST_TOLERANCE_PERCENT,
  DR_RTO_LIMIT_MS,
  REQUIRED_GOVERNANCE_IDS,
  REQUIRED_PRIOR_STAGES,
  createStage6DrillHarness,
  loadDrillFixture,
  runStage6AcceptanceDrill,
  verifyPactContracts,
} from "../src/stage-6-acceptance-drill.js";

const fixture = await loadDrillFixture();

test("HOBO-665 green drill closes Stage-6 gate with v1 GA checklist complete", () => {
  const result = runStage6AcceptanceDrill(fixture.scenarios.greenDrill);

  assert.equal(result.ok, true);
  assert.equal(result.issue, "HOBO-665");
  assert.equal(result.acceptanceRecordId, "S6-01");
  assert.equal(result.evidenceAttached, true);
  assert.equal(result.v1GaChecklistComplete, true);
  assert.equal(result.checks.every((check) => check.status === "pass"), true);
  assert.equal(result.priorGates?.length, REQUIRED_PRIOR_STAGES.length);
  assert.equal(result.governance?.length, REQUIRED_GOVERNANCE_IDS.length);
});

test("canary health regression auto-rolls-back without live services", () => {
  const result = runStage6AcceptanceDrill(fixture.scenarios.greenDrill);
  const canary = result.checks.find((check) => check.id === "canary-auto-rollback");

  assert.equal(canary?.status, "pass");
  assert.match(canary?.detail ?? "", /auto-rolled-back/i);
});

test("plan-time cost within ±20% of fixture", () => {
  const pass = runStage6AcceptanceDrill(fixture.scenarios.greenDrill);
  const fail = runStage6AcceptanceDrill(fixture.scenarios.costOutOfTolerance);

  assert.equal(pass.checks.find((c) => c.id === "plan-time-cost-tolerance")?.status, "pass");
  assert.equal(fail.checks.find((c) => c.id === "plan-time-cost-tolerance")?.status, "fail");
  assert.match(
    fail.checks.find((c) => c.id === "plan-time-cost-tolerance")?.detail ?? "",
    new RegExp(`±${COST_TOLERANCE_PERCENT}%`),
  );
});

test("DR rebuild from log replay stays under 15 min RTO", () => {
  const pass = runStage6AcceptanceDrill(fixture.scenarios.greenDrill);
  const fail = runStage6AcceptanceDrill(fixture.scenarios.drRtoExceeded);

  assert.equal(pass.checks.find((c) => c.id === "dr-rebuild-rto")?.status, "pass");
  assert.equal(fail.checks.find((c) => c.id === "dr-rebuild-rto")?.status, "fail");
  assert.equal(fixture.scenarios.drRtoExceeded.dr.replayDurationMs > DR_RTO_LIMIT_MS, true);
});

test("dashboard WCAG 2.1 AA and pseudo-loc audits must both pass", () => {
  const pass = runStage6AcceptanceDrill(fixture.scenarios.greenDrill);
  const fail = runStage6AcceptanceDrill(fixture.scenarios.dashboardAuditFailure);

  assert.equal(pass.checks.find((c) => c.id === "dashboard-a11y-audits")?.status, "pass");
  assert.equal(fail.checks.find((c) => c.id === "dashboard-a11y-audits")?.status, "fail");
});

test("four governance-plane evidence items pass on green drill", () => {
  const result = runStage6AcceptanceDrill(fixture.scenarios.greenDrill);

  assert.deepEqual(
    result.governance?.map((item) => item.id).sort(),
    [...REQUIRED_GOVERNANCE_IDS].sort(),
  );
  assert.equal(result.governance?.every((item) => item.passed), true);
});

test("governance bypass attempts fail closed", () => {
  const result = runStage6AcceptanceDrill(fixture.scenarios.governanceBypass);

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.id === "governance-evidence")?.status, "fail");
  assert.equal(result.governance?.every((item) => item.passed), false);
});

test("prior stage gates S0-S5 re-run green per ADR-0063", () => {
  const pass = runStage6AcceptanceDrill(fixture.scenarios.greenDrill);
  const fail = runStage6AcceptanceDrill(fixture.scenarios.priorGateRegression);

  assert.equal(pass.checks.find((c) => c.id === "prior-stage-gates")?.status, "pass");
  assert.equal(fail.checks.find((c) => c.id === "prior-stage-gates")?.status, "fail");
  assert.match(fail.checks.find((c) => c.id === "prior-stage-gates")?.detail ?? "", /S3/);
});

test("rollback compensation failure does not self-certify canary gate", () => {
  const result = runStage6AcceptanceDrill(fixture.scenarios.rollbackCompensationFailure);

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.id === "canary-auto-rollback")?.status, "fail");
});

test("every mocked boundary has a Pact file and verifies", async () => {
  const harness = createStage6DrillHarness(fixture.scenarios.greenDrill);
  const result = await verifyPactContracts(harness);

  assert.equal(result.status, "verified");
  assert.deepEqual(
    result.boundaries.map((boundary) => boundary.id).sort(),
    CONTRACT_BOUNDARIES.map((boundary) => boundary.id).sort(),
  );

  for (const boundary of CONTRACT_BOUNDARIES) {
    const pact = JSON.parse(
      await readFile(new URL(`../contracts/pacts/${boundary.pactFile}`, import.meta.url), "utf8"),
    );
    assert.equal(pact.metadata.boundaryId, boundary.id);
    assert.ok(pact.interactions.length > 0);
  }
});
