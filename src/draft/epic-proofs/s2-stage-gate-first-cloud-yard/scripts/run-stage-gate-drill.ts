#!/usr/bin/env node
import { assertStageGateDrill, createS2StageGateDrillContract, runStageGateDrill } from "../src/s2-stage-gate-drill.js";

const contract = createS2StageGateDrillContract();
const report = assertStageGateDrill(runStageGateDrill(contract));

console.log(
  JSON.stringify(
    {
      ok: true,
      schema: report.schema,
      fixture: contract.fixture,
      provider: contract.provider,
      ciLane: contract.credentialedCiLane,
      arms: report.arms,
      evidencePath: report.evidencePath,
    },
    null,
    2,
  ),
);
