import {
  createStage6DrillHarness,
  loadDrillFixture,
  runStage6AcceptanceDrill,
} from "../src/stage-6-acceptance-drill.js";

const fixture = await loadDrillFixture();
const green = runStage6AcceptanceDrill(fixture.scenarios.greenDrill);

console.log(
  JSON.stringify(
    {
      scenario: green.scenario,
      ok: green.ok,
      acceptanceRecordId: green.acceptanceRecordId,
      evidenceAttached: green.evidenceAttached,
      v1GaChecklistComplete: green.v1GaChecklistComplete,
      checks: green.checks.map((check) => ({ id: check.id, status: check.status })),
      priorGates: green.priorGates?.map((gate) => gate.stage),
      governance: green.governance?.map((item) => item.id),
    },
    null,
    2,
  ),
);

if (!green.ok) {
  process.exitCode = 1;
}

const harness = createStage6DrillHarness(fixture.scenarios.greenDrill);
const adversarial = [
  fixture.scenarios.costOutOfTolerance,
  fixture.scenarios.drRtoExceeded,
  fixture.scenarios.governanceBypass,
  fixture.scenarios.priorGateRegression,
  fixture.scenarios.rollbackCompensationFailure,
  fixture.scenarios.dashboardAuditFailure,
].map((scenario) => runStage6AcceptanceDrill(scenario));

if (adversarial.some((result) => result.ok)) {
  console.error("adversarial scenarios must fail closed");
  process.exitCode = 1;
}

void harness;
