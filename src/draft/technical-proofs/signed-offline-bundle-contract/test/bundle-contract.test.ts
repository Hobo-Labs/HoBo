import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  createFixtureBundle,
  parseBundleImportEvent,
  parseBundleManifest,
  serializeBundleManifest
} from "../src/bundle-contract.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("signed offline bundle manifest validates a multi-artifact air-gap fixture", () => {
  const bundle = createFixtureBundle();
  const parsed = parseBundleManifest(bundle);

  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  assert.equal(parsed.manifest.schema, "registry.bundle/v1");
  assert.equal(parsed.manifest.contents.listings.length, 2);
  assert.equal(parsed.manifest.contents.baseImages.length, 1);
  assert.equal(parsed.manifest.contents.modelWeights.length, 1);
  assert.equal(parsed.resolvedListings[0].descriptorDigest, bundle.contents.listings[0].descriptor.digest);
  assert.match(serializeBundleManifest(bundle), /"schema": "registry.bundle\/v1"/);
});

test("registry.BundleImported event validates a fixture import result", () => {
  const bundle = createFixtureBundle();
  const parsed = parseBundleImportEvent({
    type: "registry.BundleImported",
    bundleDigest: bundle.bundleDigest,
    importedAt: "2026-06-25T07:55:00.000Z",
    verification: {
      signature: "passed",
      provenance: "passed",
      conformance: "passed",
      revocation: "passed",
      antiRollback: "passed",
      transparency: "passed"
    },
    importedArtifacts: bundle.contents.listings.map((listing) => listing.descriptor.digest)
  });

  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
});

test("schema and declarations publish the bundle contract surface", async () => {
  const schemaText = await readFile(
    path.join(packageRoot, "schema", "registry.bundle.v1.schema.json"),
    "utf8"
  );
  const eventSchemaText = await readFile(
    path.join(packageRoot, "schema", "registry.bundle-imported.v1.schema.json"),
    "utf8"
  );
  const typeDeclarations = await readFile(
    path.join(packageRoot, "src", "bundle-contract.d.ts"),
    "utf8"
  );

  const schema = JSON.parse(schemaText);
  const eventSchema = JSON.parse(eventSchemaText);
  assert.equal(schema.$id, "https://schemas.hobo.dev/registry.bundle.v1.schema.json");
  assert.equal(eventSchema.$id, "https://schemas.hobo.dev/registry.bundle-imported.v1.schema.json");
  assert.equal(eventSchema.properties.type.const, "registry.BundleImported");
  assert.deepEqual(schema.required, [
    "schema",
    "bundleId",
    "version",
    "createdAt",
    "bundleDigest",
    "curator",
    "contents",
    "trust"
  ]);
  assert.match(typeDeclarations, /export interface RegistryBundleManifest/);
  assert.match(typeDeclarations, /export interface RegistryBundleImportedEvent/);
});


test("bundle manifest rejects missing air-gap trust materials and per-artifact timestamps", () => {
  const bundle = createFixtureBundle();
  delete bundle.curator;
  delete bundle.contents.listings[1].conformanceReports;
  delete bundle.trust.revocationList;
  delete bundle.contents.listings[0].transparency.inclusionProof;
  delete bundle.contents.baseImages[0].buildTimestamp;

  const parsed = parseBundleManifest(bundle);

  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join("\n"), /curator must be an object/);
  assert.match(parsed.errors.join("\n"), /contents\.listings\.1\.conformanceReports must be a non-empty array/);
  assert.match(parsed.errors.join("\n"), /trust\.revocationList is required/);
  assert.match(parsed.errors.join("\n"), /contents\.listings\.0\.transparency\.inclusionProof/);
  assert.match(parsed.errors.join("\n"), /contents\.baseImages\.0\.buildTimestamp must be an ISO timestamp/);
});

test("bundle manifest rejects tag references and transparency proofs for another log root", () => {
  const bundle = createFixtureBundle();
  bundle.bundleDigest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  bundle.contents.listings[0].descriptor = {
    mediaType: "application/vnd.hobo.registry.descriptor.v1+json",
    uri: "oci://registry.example/hobo/provider-aws-descriptor:latest",
    tag: "latest"
  };
  bundle.contents.modelWeights[0].transparency.logId = "other-log";
  bundle.contents.modelWeights[0].transparency.logRoot =
    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

  const parsed = parseBundleManifest(bundle);

  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join("\n"), /contents\.listings\.0\.artifact\.tag is not allowed/);
  assert.match(parsed.errors.join("\n"), /contents\.listings\.0\.artifact\.digest must be sha256/);
  assert.match(parsed.errors.join("\n"), /bundleDigest must match canonical manifest content/);
  assert.match(parsed.errors.join("\n"), /contents\.modelWeights\.0\.transparency\.logId must match trust\.transparencyLog\.logId/);
  assert.match(parsed.errors.join("\n"), /contents\.modelWeights\.0\.transparency\.logRoot must match trust\.transparencyLog\.pinnedRoot/);
});
