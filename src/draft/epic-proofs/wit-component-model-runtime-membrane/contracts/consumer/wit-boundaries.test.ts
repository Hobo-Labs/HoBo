import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import {
  CONTRACT_BOUNDARIES,
  PACT_CONSUMER_NAME,
  loadMembraneFixture,
  runMembraneReferenceSimulation,
  verifyPactContracts,
} from "../../services/wit-runtime-reference.js";

test("scenario fixtures only cross declared contract boundaries", async () => {
  const fixture = await loadMembraneFixture();
  const knownBoundaries = new Set(CONTRACT_BOUNDARIES.map((boundary) => boundary.id));

  for (const scenario of Object.values(fixture.scenarios)) {
    const result = await runMembraneReferenceSimulation(scenario);
    assert.equal(result.liveNetworkCalls.length, 0);
    assert.equal(result.boundaries.every((boundary) => knownBoundaries.has(boundary.id)), true);
    assert.equal(result.boundaries.every((boundary) => boundary.mocked), true);
  }
});

test("consumer Pact fixtures match the reference implementation boundary registry", async () => {
  const verification = await verifyPactContracts();

  assert.equal(verification.status, "verified");
  assert.equal(verification.consumer, PACT_CONSUMER_NAME);

  for (const boundary of CONTRACT_BOUNDARIES) {
    const pact = JSON.parse(await readFile(new URL(`../pacts/${boundary.pactFile}`, import.meta.url), "utf8"));
    assert.equal(pact.metadata.boundaryId, boundary.id);
    assert.equal(pact.consumer.name, PACT_CONSUMER_NAME);
    assert.equal(pact.provider.name, boundary.provider);
  }
});
