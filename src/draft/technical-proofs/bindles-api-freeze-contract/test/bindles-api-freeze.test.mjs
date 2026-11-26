import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import * as bindlesCatalog from "../../hobo-bindles-resource-catalog/src/catalog.ts";
import {
  assertManifestFreeze,
  assertNoInternalCloudSymbols,
  assertPublicApiSnapshot,
  assertSchemaVersionBumpForContractChange,
  createBindlesPublicApiSnapshot,
  createRepresentativeManifest,
  evaluateBindlesFreezeMatrix,
} from "../src/bindles-api-freeze.mjs";

test("@hobo/bindles public API snapshot catches signature and internal symbol drift", async () => {
  const expected = await readFixture("bindles-public-api.snapshot.json");
  const actual = createBindlesPublicApiSnapshot();

  assert.deepEqual(actual, expected);
  assert.doesNotThrow(() => assertPublicApiSnapshot(actual, expected));
  assert.doesNotThrow(() => assertNoInternalCloudSymbols(actual));

  const changedSignature = structuredClone(actual);
  const kvExport = changedSignature.exports.find((entry) => entry.name === "kv");
  kvExport.signature = "kv(name: string, options: AwsRdsInternalOptions): ResourceHandle<\"kv\", \"get\">";

  assert.throws(
    () => assertPublicApiSnapshot(changedSignature, expected),
    /BINDLES_API_SNAPSHOT_MISMATCH/,
  );
  assert.throws(
    () => assertNoInternalCloudSymbols(changedSignature),
    /BINDLES_API_INTERNAL_SYMBOL_LEAK/,
  );

  const addedExport = createBindlesPublicApiSnapshot({
    ...bindlesCatalog,
    AwsRdsInternalOptions: Object.freeze({}),
  });

  assert.throws(
    () => assertPublicApiSnapshot(addedExport, expected),
    /BINDLES_API_SNAPSHOT_MISMATCH/,
  );
  assert.throws(
    () => assertNoInternalCloudSymbols(addedExport),
    /BINDLES_API_INTERNAL_SYMBOL_LEAK/,
  );
});

test("edge matrix freezes narrowing, coverage, XAA, raw, .with(), and combined adversarial cases", () => {
  const matrix = evaluateBindlesFreezeMatrix();
  const cases = new Map(matrix.cases.map((entry) => [entry.name, entry]));

  assert.equal(matrix.ok, true);
  assert.deepEqual(cases.get("allow-narrow-below-usage").assertedCodes, [
    "capability.required-not-granted",
  ]);
  assert.deepEqual(cases.get("collection-coverage-gap").assertedCodes, [
    "collection.coverage.unobserved-resource",
  ]);
  assert.deepEqual(cases.get("xaa-least-privilege").manifest.connectors.asana.allow, [
    "tasks:write",
  ]);
  assert.deepEqual(cases.get("xaa-narrow-override").assertedCodes, [
    "xaa.scope.exceeds-declared-allow",
  ]);
  assert.deepEqual(cases.get("raw-non-portable").assertedCodes, [
    "RAW_DRIVER_PORTABILITY_DEBT",
  ]);
  assert.equal(cases.get("provider-with-inert").resolution.applied.provider, "aws");
  assert.deepEqual(cases.get("provider-with-inert").resolution.inert.map((entry) => entry.provider), [
    "azure",
  ]);
  assert.deepEqual(cases.get("combined-narrowing-coverage").assertedCodes, [
    "capability.required-not-granted",
    "collection.coverage.unobserved-resource",
  ]);
});

test("golden hobo.manifest/v1 IR pins representative Bindle shape and schema bump discipline", async () => {
  const golden = await readFixture("representative-manifest.v1.json");
  const manifest = createRepresentativeManifest();

  assert.deepEqual(manifest, golden);
  assert.doesNotThrow(() => assertManifestFreeze(manifest, golden));

  const changedWithoutBump = structuredClone(golden);
  changedWithoutBump.resources.api.annotations.telemetry = { sink: "otel" };

  assert.throws(
    () => assertSchemaVersionBumpForContractChange(golden, changedWithoutBump),
    /MANIFEST_SCHEMA_VERSION_REQUIRED/,
  );
});

async function readFixture(fileName) {
  const url = new URL(`../fixtures/${fileName}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8"));
}
