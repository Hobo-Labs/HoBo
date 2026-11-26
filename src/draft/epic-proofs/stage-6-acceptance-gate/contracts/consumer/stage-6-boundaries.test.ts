import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import { CONTRACT_BOUNDARIES, createStage6DrillHarness, loadDrillFixture } from "../../src/stage-6-acceptance-drill.js";

const fixture = await loadDrillFixture();

test("consumer contracts cover every Stage-6 acceptance boundary", async () => {
  const harness = createStage6DrillHarness(fixture.scenarios.greenDrill);

  for (const boundary of CONTRACT_BOUNDARIES) {
    const pact = JSON.parse(
      await readFile(new URL(`../pacts/${boundary.pactFile}`, import.meta.url), "utf8"),
    );
    assert.equal(pact.consumer.name, "stage-6-acceptance-gate-reference");
    assert.equal(pact.metadata.boundaryId, boundary.id);

    switch (boundary.id) {
      case "canary-rollback":
        assert.equal(harness.evaluateCanaryRollback().status, "pass");
        break;
      case "finops-cost-estimate":
        assert.equal(harness.evaluatePlanTimeCost().status, "pass");
        break;
      case "dr-replay-rebuild":
        assert.equal(harness.evaluateDrRebuild().status, "pass");
        break;
      case "dashboard-a11y-audit":
        assert.equal(harness.evaluateDashboardAudits().status, "pass");
        break;
      case "governance-plane":
        assert.equal(harness.evaluateGovernance().status, "pass");
        break;
      case "prior-stage-gates":
        assert.equal(harness.evaluatePriorGates().status, "pass");
        break;
      case "acceptance-record": {
        const drill = harness.runDrill();
        assert.equal(drill.acceptanceRecordId, "S6-01");
        assert.equal(drill.evidenceAttached, true);
        break;
      }
    }
  }
});
