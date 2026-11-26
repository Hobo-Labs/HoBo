import { readFile } from "node:fs/promises";

import {
  runReliabilityObservabilityCostSimulation,
} from "../services/reliability-reference-architecture.js";

const fixtureUrl = new URL("./fixtures/reliability-reference-fixtures.json", import.meta.url);
const fixtures = JSON.parse(await readFile(fixtureUrl, "utf8"));
const result = await runReliabilityObservabilityCostSimulation();

const summary = {
  epic: result.epic,
  fixtureSet: fixtures.fixtureSet,
  verticalSlices: result.verticalSlices.map((slice) => ({
    id: slice.id,
    persona: slice.persona,
    mockedBoundaries: slice.boundaries.map((boundary) => boundary.name),
  })),
  proofs: {
    telemetryRollback: {
      sloStatus: result.telemetry.sloStatus.status,
      rollbackEffect: result.telemetry.rollbackGate.effect,
      traceRepair: result.telemetry.traceRepair,
    },
    finopsGuard: {
      meteringTotalCostUsd: result.finops.metering.totalCostUsd,
      quotaEffect: result.finops.quotaDecision.effect,
      runawayBreaker: result.finops.runawayBreaker.decision,
      observabilityCostGuard: result.finops.costGuard.outcome,
    },
    sagaRecovery: {
      failureClass: result.recovery.failureClass,
      sagaStatus: result.recovery.saga.status,
      compensationOrder: result.recovery.compensation.order,
    },
    goldenStatus: {
      goldenChaosStatus: result.status.goldenChaos.status,
      rollupStatus: result.status.rollup.environmentStatus,
      publicStatus: result.status.rollup.publicStatus,
    },
  },
  contracts: result.contracts.covered,
  negativeCases: result.negative,
};

console.log(JSON.stringify(summary, null, 2));
