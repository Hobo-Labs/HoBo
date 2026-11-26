import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

import { runDataPlaneReferenceSimulation } from "../../services/data-plane-reference-architecture.js";

const pactRoot = new URL("../pacts/", import.meta.url);

test("data-plane reference simulation satisfies every declared Pact boundary", async () => {
  const result = await runDataPlaneReferenceSimulation();
  const pacts = await Promise.all([
    loadPact("eventstore-append-boundary.pact.json"),
    loadPact("projection-sink-boundary.pact.json"),
    loadPact("subscription-gateway-boundary.pact.json"),
    loadPact("graphql-facade-boundary.pact.json"),
    loadPact("search-embed-boundary.pact.json"),
    loadPact("governance-erasure-boundary.pact.json"),
  ]);

  assert.deepEqual(
    result.contracts.covered.sort(),
    [
      "EventStoreAppendBoundary",
      "ProjectionSinkBoundary",
      "SubscriptionGatewayBoundary",
      "GraphqlFacadeBoundary",
      "SearchEmbedBoundary",
      "GovernanceErasureBoundary",
    ].sort(),
  );
  assert.equal(result.contracts.missing.length, 0);

  const providers = pacts.map((pact) => pact.provider.name).sort();
  assert.deepEqual(providers, result.contracts.covered.sort());
});

async function loadPact(name) {
  return JSON.parse(await readFile(new URL(path.posix.join("./", name), pactRoot), "utf8"));
}
