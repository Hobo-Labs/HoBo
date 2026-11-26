import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

import {
  runReliabilityObservabilityCostSimulation,
} from "../../services/reliability-reference-architecture.js";

const pactRoot = new URL("../pacts/", import.meta.url);
const pactFiles = [
  "telemetry-boundary-export.pact.json",
  "trace-context-queue.pact.json",
  "slo-policy-gate.pact.json",
  "metering-credit-ledger.pact.json",
  "budget-quota-policy-gate.pact.json",
  "saga-compensation-boundary.pact.json",
  "golden-chaos-boundary.pact.json",
  "reliability-status-rollup.pact.json",
];

test("Reliability reference simulation satisfies every declared Pact boundary", async () => {
  const result = await runReliabilityObservabilityCostSimulation();
  const pacts = await Promise.all(pactFiles.map(loadPact));

  assert.equal(result.contracts.missing.length, 0);
  assert.deepEqual(
    result.contracts.covered.sort(),
    [
      "TelemetryBoundaryExport",
      "TraceContextQueue",
      "SloPolicyGate",
      "MeteringCreditLedger",
      "BudgetQuotaPolicyGate",
      "SagaCompensationBoundary",
      "GoldenChaosBoundary",
      "ReliabilityStatusRollup",
    ].sort(),
  );
  assert.deepEqual(
    pacts.map((pact) => pact.provider.name).sort(),
    result.contracts.covered.sort(),
  );
  assert.ok(
    pacts.every((pact) => pact.consumer.name === "ReliabilityReferenceApp"),
    "all boundary pacts must be consumer-driven by the epic simulation",
  );
});

async function loadPact(name) {
  return JSON.parse(await readFile(new URL(path.posix.join("./", name), pactRoot), "utf8"));
}
