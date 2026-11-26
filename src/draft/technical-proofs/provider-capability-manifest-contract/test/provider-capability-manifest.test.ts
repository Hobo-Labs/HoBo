import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_MANIFEST_SCHEMA,
  canonicalJson,
  createFixtureProvider,
  negotiateCapability,
  serializeWellKnownManifest,
  stableDigest,
  validateCapabilityManifest
} from "../src/provider-capability-manifest.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("fixture provider publishes a complete capability manifest at the well-known shape", () => {
  const provider = createFixtureProvider();
  const manifest = provider.capabilityManifest();
  const validation = validateCapabilityManifest(manifest, {
    conformance: provider.conformanceReport,
    servedRegions: provider.servedRegions
  });
  const wellKnown = serializeWellKnownManifest(manifest);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(manifest.schema, CAPABILITY_MANIFEST_SCHEMA);
  assert.equal(manifest.provider.id, "fixture-local-provider");
  assert.deepEqual(manifest.regions, ["us-east-1", "us-west-2"]);
  assert.equal(manifest.capabilities.find((capability) => capability.port === "hobo:build-machine").features.length, 2);
  assert.equal(manifest.cost.facts.some((fact) => fact.freeTier.included > 0), true);
  assert.deepEqual(Object.keys(wellKnown).sort(), [
    "/.well-known/capability-manifest/auth.json",
    "/.well-known/capability-manifest/capabilities.json",
    "/.well-known/capability-manifest/cost.json",
    "/.well-known/capability-manifest/index.json"
  ]);
  assert.equal(
    stableDigest(JSON.parse(wellKnown["/.well-known/capability-manifest/index.json"])),
    "94db68795e5f83c054d8ed852718872f06e3af9185df6cdb26a34ea5be25e814"
  );
});

test("capability negotiation rejects unsupported require with precise remediation", () => {
  const fixture = createFixtureProvider();
  const better = createFixtureProvider({
    id: "gpu-runner-provider",
    capabilities: [
      {
        port: "hobo:runner",
        interface: "hobo:runner/job",
        version: "0.1.0",
        stability: "preview",
        features: ["ci-job", "gpu"],
        regions: ["us-east-1"]
      }
    ]
  });

  const decision = negotiateCapability({
    manifest: fixture.capabilityManifest(),
    request: {
      require: {
        port: "hobo:runner",
        features: ["gpu"]
      }
    },
    registry: [fixture.capabilityManifest(), better.capabilityManifest()]
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.reason.code, "capability.unsupported");
  assert.match(decision.reason.message, /requires gpu/);
  assert.deepEqual(decision.remediation, {
    action: "choose-provider",
    providerId: "gpu-runner-provider",
    port: "hobo:runner",
    satisfies: ["gpu"]
  });
});

test("capability claims without matching conformance coverage fail closed", () => {
  const provider = createFixtureProvider();
  const manifest = provider.capabilityManifest();
  manifest.capabilities.push({
    port: "hobo:artifact-repo",
    interface: "hobo:artifact-repo/repository",
    version: "0.1.0",
    stability: "preview",
    features: ["pull", "publish"],
    regions: ["us-east-1"]
  });

  const validation = validateCapabilityManifest(manifest, {
    conformance: provider.conformanceReport,
    servedRegions: provider.servedRegions
  });

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /capability hobo:artifact-repo is not covered by conformance/);
});

test("cost facts are declared evidence, not trusted opaque provider claims", () => {
  const provider = createFixtureProvider();
  const manifest = provider.capabilityManifest();
  manifest.cost.facts[0].source = {
    type: "provider-asserted",
    url: "https://example.invalid/cheap"
  };

  const validation = validateCapabilityManifest(manifest, {
    conformance: provider.conformanceReport,
    servedRegions: provider.servedRegions
  });

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /cost.facts.0.source.type must be declared-provider/);
});

test("regions outside the provider served set are rejected before matching", () => {
  const provider = createFixtureProvider();
  const manifest = provider.capabilityManifest();
  manifest.regions.push("moon-1");
  manifest.capabilities[0].regions.push("moon-1");

  const validation = validateCapabilityManifest(manifest, {
    conformance: provider.conformanceReport,
    servedRegions: provider.servedRegions
  });

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /region moon-1 is not served by provider fixture-local-provider/);
});

test("schema and type declarations publish the authoring contract surface", async () => {
  const schemaText = await readFile(
    path.join(packageRoot, "schema", "provider-capability-manifest.v1.schema.json"),
    "utf8"
  );
  const typeDeclarations = await readFile(
    path.join(packageRoot, "src", "provider-capability-manifest.d.ts"),
    "utf8"
  );

  const schema = JSON.parse(schemaText);
  assert.equal(schema.$id, "https://schemas.hobo.dev/provider-capability-manifest.v1.schema.json");
  assert.equal(schema.properties.schema.const, CAPABILITY_MANIFEST_SCHEMA);
  assert.match(typeDeclarations, /export interface CapabilityManifest/);
  assert.match(typeDeclarations, /capabilityManifest\(\): CapabilityManifest/);
});

test("well-known serialization is deterministic and round-trippable", () => {
  const provider = createFixtureProvider();
  const manifest = provider.capabilityManifest();
  const first = serializeWellKnownManifest(manifest);
  const second = serializeWellKnownManifest(JSON.parse(canonicalJson(manifest)));

  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(first["/.well-known/capability-manifest/capabilities.json"]), {
    schema: "hobo.capabilities/v1",
    providerId: "fixture-local-provider",
    capabilities: manifest.capabilities
  });
});
