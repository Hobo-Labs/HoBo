import { runStageGateS3Drill } from "../services/stage-gate-s3-drill.js";

const result = await runStageGateS3Drill();

console.log(JSON.stringify({
  issue: result.epic.issueId,
  journey: result.epic.journey,
  fixture: result.epic.fixture,
  contracts: result.contracts,
  j2Steps: result.scenarios.journey,
  selfCorrected: result.scenarios.selfCorrection.deploy.ok,
  tokenEvents: result.scenarios.tokenEvents,
  replayable: result.scenarios.replay.replayable,
  brokeredOnly: result.scenarios.traceScan.brokeredOnly,
  prodGate: result.scenarios.prodDeployBlocked.decision.effect,
}, null, 2));
