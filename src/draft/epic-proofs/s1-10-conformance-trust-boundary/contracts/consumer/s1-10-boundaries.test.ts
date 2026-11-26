import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

const pactRoot = new URL("../../architecture/pacts/", import.meta.url);

test("declared conformance pacts are present with interactions", async () => {
  const pacts = await Promise.all([
    loadPact("conformance-runtime-port-backend.pact.json"),
    loadPact("conformance-component-host.pact.json"),
  ]);

  assert.equal(pacts[0].consumer.name, "@hobo/conformance");
  assert.equal(pacts[1].consumer.name, "@hobo/conformance");
  assert.equal(pacts.every((pact) => pact.interactions.length > 0), true);
});

async function loadPact(name: string) {
  return JSON.parse(await readFile(new URL(path.posix.join("./", name), pactRoot), "utf8"));
}
