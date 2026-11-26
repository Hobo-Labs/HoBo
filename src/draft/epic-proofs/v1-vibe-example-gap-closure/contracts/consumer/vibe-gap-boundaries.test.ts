import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

import { evaluateVibeGapClosure } from "../../src/vibe-gap-closure.js";

const pactRoot = new URL("../pacts/", import.meta.url);

const expectedProviders = [
  "VibeChildBacklogBoundary",
  "VibeDxBackboneBoundary",
  "VibeScopeGuardBoundary",
  "VibeUnblockLedgerBoundary",
];

test("vibe gap closure simulation satisfies every declared Pact-style boundary", async () => {
  const result = evaluateVibeGapClosure();
  const pacts = await Promise.all([
    loadPact("vibe-child-backlog-boundary.pact.json"),
    loadPact("vibe-dx-backbone-boundary.pact.json"),
    loadPact("vibe-scope-guard-boundary.pact.json"),
    loadPact("vibe-unblock-ledger-boundary.pact.json"),
  ]);

  assert.deepEqual(result.summary.contracts.covered.sort(), expectedProviders.sort());
  assert.equal(result.summary.contracts.missing.length, 0);
  assert.deepEqual(
    pacts.map((pact) => pact.provider.name).sort(),
    expectedProviders.sort(),
  );
  assert.equal(pacts.every((pact) => pact.consumer.name === "V1VibeGapClosureReferenceApp"), true);
  assert.equal(pacts.every((pact) => pact.interactions.length > 0), true);
});

async function loadPact(name: string) {
  return JSON.parse(await readFile(new URL(path.posix.join("./", name), pactRoot), "utf8"));
}
