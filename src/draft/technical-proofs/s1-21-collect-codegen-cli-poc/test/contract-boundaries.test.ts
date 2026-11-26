import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pactsDir = join(packageRoot, "contracts/pacts");

test("cli-collect-engine-boundary pact documents collector interaction shape", async () => {
  const pact = JSON.parse(await readFile(join(pactsDir, "cli-collect-engine-boundary.pact.json"), "utf8"));
  assert.equal(pact.consumer.name, "@hobo/cli");
  assert.equal(pact.provider.name, "@hobo/collector");
  assert.equal(pact.interactions[0].response.body.manifest.schema, "hobo.manifest/v1");
});

test("cli-codegen-pipeline-boundary pact documents codegen pipeline interaction shape", async () => {
  const pact = JSON.parse(await readFile(join(pactsDir, "cli-codegen-pipeline-boundary.pact.json"), "utf8"));
  assert.equal(pact.consumer.name, "@hobo/cli");
  assert.equal(pact.provider.name, "@hobo/codegen-pipeline");
  assert.deepEqual(pact.interactions[0].response.body.layout, [".hobo/generated", "src/_generated"]);
});
