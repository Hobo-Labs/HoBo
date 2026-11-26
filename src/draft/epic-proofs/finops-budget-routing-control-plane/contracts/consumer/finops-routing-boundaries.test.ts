import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

import {
  runFinopsRoutingControlPlaneSimulation,
} from "../../services/finops-routing-control-plane.js";

const pactRoot = new URL("../pacts/", import.meta.url);
const pactFiles = [
  "metric-contract-registry.pact.json",
  "constraint-engine.pact.json",
  "pareto-evaluator.pact.json",
  "stability-controller.pact.json",
  "decision-graph-publisher.pact.json",
  "feedback-proposal-gate.pact.json",
  "simulation-runner.pact.json",
];

test("FinOps routing simulation satisfies every declared Pact boundary", async () => {
  const result = await runFinopsRoutingControlPlaneSimulation();
  const pacts = await Promise.all(pactFiles.map(loadPact));

  assert.deepEqual(result.contracts.missing, []);
  assert.deepEqual(
    pacts.map((pact) => pact.provider.name).sort(),
    result.contracts.covered.sort(),
  );
  assert.ok(
    pacts.every((pact) => pact.consumer.name === "FinopsRoutingControlPlaneEpic"),
    "all boundary pacts must be consumer-driven by the epic simulation",
  );
  assert.ok(
    pacts.every((pact) => pact.interactions.length > 0),
    "each mocked boundary must declare at least one consumer interaction",
  );
});

async function loadPact(name) {
  return JSON.parse(await readFile(new URL(path.posix.join("./", name), pactRoot), "utf8"));
}
