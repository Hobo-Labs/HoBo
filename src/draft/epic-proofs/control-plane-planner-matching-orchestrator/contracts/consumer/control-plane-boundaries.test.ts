import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_BOUNDARIES,
  runControlPlaneReferenceSimulation
} from "../../services/control-plane-reference-architecture.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pactDir = path.resolve(__dirname, "..", "pacts");

test("Pact fixtures cover all Control Plane service boundaries from the consumer perspective", async () => {
  const pactFiles = (await readdir(pactDir)).filter((file) => file.endsWith(".pact.json"));
  const expectedFiles = CONTRACT_BOUNDARIES.map((boundary) => `${boundary.slug}.pact.json`).sort();

  assert.deepEqual([...pactFiles].sort(), expectedFiles);

  const pacts = await Promise.all(
    pactFiles.map(async (file) => {
      const pact = JSON.parse(await readFile(path.join(pactDir, file), "utf8"));
      return { file, pact };
    })
  );

  const providers = pacts.map(({ pact }) => pact.provider.name).sort();
  assert.deepEqual(providers, CONTRACT_BOUNDARIES.map((boundary) => boundary.provider).sort());

  for (const { pact } of pacts) {
    assert.equal(pact.consumer.name, "ControlPlaneReferenceApp");
    assert.equal(Array.isArray(pact.interactions), true);
    assert.equal(pact.interactions.length > 0, true);
    assert.equal(JSON.stringify(pact).includes("https://live"), false);
    assert.equal(JSON.stringify(pact).includes("secret-value"), false);
  }

  const result = await runControlPlaneReferenceSimulation();
  assert.deepEqual([...result.contracts.covered].sort(), providers);
});
