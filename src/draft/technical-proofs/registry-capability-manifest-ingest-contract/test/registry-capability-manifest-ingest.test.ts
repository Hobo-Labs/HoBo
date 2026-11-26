import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import { createCloudflareProvider } from "../../provider-cloudflare-contract/src/provider-cloudflare.js";
import { createFixtureProvider } from "../../provider-capability-manifest-contract/src/provider-capability-manifest.js";
import {
  REGISTRY_INGEST_CONTRACT,
  WELL_KNOWN_PREFIX,
  buildCloudflareWellKnownBundle,
  buildFixtureWellKnownBundle,
  createCapabilityRegistry,
  createFixtureSigningKey,
  signWellKnownBundle,
} from "../src/registry-capability-manifest-ingest.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Given a signed well-known bundle When the registry ingests it Then capabilities auth and cost are indexed", () => {
  const registry = createCapabilityRegistry();
  const provider = createFixtureProvider();
  const documents = buildFixtureWellKnownBundle(provider);

  const result = registry.ingestWellKnown({
    documents,
    conformance: provider.conformanceReport,
    servedRegions: provider.servedRegions,
    trust: { trustedIssuer: "https://identity.hobo.local" },
  });

  assert.equal(result.ok, true, result.errors?.join("\n"));
  assert.equal(result.providerId, "fixture-local-provider");

  const stored = registry.getProvider("fixture-local-provider");
  assert.ok(stored);
  assert.equal(stored.manifest.schema, "hobo.capability-manifest/v1");
  assert.equal(stored.auth.mode, "svid-federation");
  assert.equal(stored.cost.currency, "USD");

  const search = registry.searchCapabilities({ port: "hobo:runner", features: ["ci-job"] });
  assert.equal(search.ok, true);
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].providerId, "fixture-local-provider");
});

test("Given a first provider ingest When events are projected Then ProviderRegistered and CapabilityManifestUpdated land", () => {
  const registry = createCapabilityRegistry();
  const documents = buildFixtureWellKnownBundle();
  const provider = createFixtureProvider();

  registry.ingestWellKnown({
    documents,
    conformance: provider.conformanceReport,
    servedRegions: provider.servedRegions,
  });

  const events = registry.events();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.type), [
    "ProviderRegistered",
    "CapabilityManifestUpdated",
  ]);
  assert.equal(events[0].contract, REGISTRY_INGEST_CONTRACT);
  assert.ok(events[0].conformanceReport);
  assert.ok(events[0].provenance);
});

test("Given the Cloudflare provider manifest When ingested through well-known Then the registry exposes edge capabilities for planner search", () => {
  const registry = createCapabilityRegistry();
  const cloudflare = createCloudflareProvider();
  const bundle = buildCloudflareWellKnownBundle({ provider: cloudflare });

  const result = registry.ingestWellKnown({
    documents: bundle.documents,
    conformance: bundle.conformance,
    servedRegions: bundle.servedRegions,
    provenance: bundle.provenance,
    trust: { trustedIssuer: "https://providers.cloudflare.hobo.local" },
  });

  assert.equal(result.ok, true, result.errors?.join("\n"));

  const planner = registry.createPlannerCapabilitySource();
  const runners = planner.listCapabilities("hobo:runner");
  assert.ok(runners.length >= 1);
  assert.ok(runners.some((entry) => entry.features.includes("edge")));

  const kv = registry.searchCapabilities({ port: "hobo:kv", regions: "WNAM" });
  assert.ok(kv.results.length >= 1);
  assert.notEqual(planner.providers().indexOf("provider-cloudflare"), -1);
});

test("Given a tampered document digest When ingest runs Then verification fails closed", () => {
  const registry = createCapabilityRegistry();
  const documents = { ...buildFixtureWellKnownBundle() };
  const capabilitiesPath = `${WELL_KNOWN_PREFIX}capabilities.json`;
  const capabilitiesDoc = JSON.parse(documents[capabilitiesPath]);
  capabilitiesDoc.capabilities[0].features.push("tampered-feature");
  documents[capabilitiesPath] = `${JSON.stringify(capabilitiesDoc, null, 2)}\n`;

  assert.throws(
    () =>
      registry.ingestWellKnown({
        documents,
        conformance: createFixtureProvider().conformanceReport,
        servedRegions: ["us-east-1", "us-west-2"],
      }),
    /document digest mismatch/,
  );
  assert.equal(registry.events().length, 0);
});

test("Given a tampered index signature When ingest runs Then verification fails closed", () => {
  const registry = createCapabilityRegistry();
  const documents = { ...buildFixtureWellKnownBundle() };
  const indexPath = `${WELL_KNOWN_PREFIX}index.json`;
  const index = JSON.parse(documents[indexPath]);
  index.signature.digest = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  documents[indexPath] = `${JSON.stringify(index, null, 2)}\n`;

  assert.throws(
    () =>
      registry.ingestWellKnown({
        documents,
        conformance: createFixtureProvider().conformanceReport,
        servedRegions: ["us-east-1", "us-west-2"],
      }),
    /signature digest mismatch/,
  );
  assert.equal(registry.events().length, 0);
});

test("Given an unsigned index When ingest runs Then verification fails closed", () => {
  const registry = createCapabilityRegistry();
  const documents = buildFixtureWellKnownBundle();
  const indexPath = `${WELL_KNOWN_PREFIX}index.json`;
  const index = JSON.parse(documents[indexPath]);
  delete index.signature;
  documents[indexPath] = `${JSON.stringify(index, null, 2)}\n`;

  assert.throws(
    () =>
      registry.ingestWellKnown({
        documents,
        conformance: createFixtureProvider().conformanceReport,
        servedRegions: ["us-east-1", "us-west-2"],
      }),
    /unsigned capability manifest index is rejected/,
  );
});

test("Given manifest capabilities without conformance coverage When ingest runs Then validation fails closed", () => {
  const registry = createCapabilityRegistry();
  const provider = createFixtureProvider();
  const documents = buildFixtureWellKnownBundle(provider);
  const capabilitiesPath = `${WELL_KNOWN_PREFIX}capabilities.json`;
  const capabilitiesDoc = JSON.parse(documents[capabilitiesPath]);
  capabilitiesDoc.capabilities.push({
    port: "hobo:artifact-repo",
    interface: "hobo:artifact-repo/repository",
    version: "0.1.0",
    stability: "preview",
    features: ["pull", "publish"],
    regions: ["us-east-1"],
  });
  documents[capabilitiesPath] = `${JSON.stringify(capabilitiesDoc, null, 2)}\n`;
  const resigned = signWellKnownBundle(documents);

  const result = registry.ingestWellKnown({
    documents: resigned,
    conformance: provider.conformanceReport,
    servedRegions: provider.servedRegions,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /not covered by conformance/);
});

test("Given a re-ingest of the same provider When manifest updates Then only CapabilityManifestUpdated is emitted", () => {
  const registry = createCapabilityRegistry();
  const provider = createFixtureProvider();
  const first = buildFixtureWellKnownBundle(provider);

  registry.ingestWellKnown({
    documents: first,
    conformance: provider.conformanceReport,
    servedRegions: provider.servedRegions,
  });

  const updatedProvider = createFixtureProvider({
    id: "fixture-local-provider",
    regions: ["us-east-1", "us-west-2", "eu-west-1"],
  });
  const second = buildFixtureWellKnownBundle(updatedProvider);

  registry.ingestWellKnown({
    documents: second,
    conformance: updatedProvider.conformanceReport,
    servedRegions: updatedProvider.servedRegions,
  });

  const events = registry.events();
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((event) => event.type),
    ["ProviderRegistered", "CapabilityManifestUpdated", "CapabilityManifestUpdated"],
  );
});

test("TypeScript declarations publish the registry ingest contract surface", async () => {
  const declarations = await readFile(
    path.join(packageRoot, "src", "registry-capability-manifest-ingest.d.ts"),
    "utf8",
  );

  assert.equal(REGISTRY_INGEST_CONTRACT, "hobo.registry-capability-manifest-ingest/v1");
  assert.match(declarations, /export interface CapabilityRegistry/);
  assert.match(declarations, /ingestWellKnown/);
  assert.match(declarations, /searchCapabilities/);
});

test("fixture signing key pins deterministic index digest for regression", () => {
  const documents = buildFixtureWellKnownBundle();
  const index = JSON.parse(documents[`${WELL_KNOWN_PREFIX}index.json`]);
  assert.equal(index.signature.alg, "HOBO-FIXTURE-SHA256");
  assert.equal(index.signature.keyId, createFixtureSigningKey().keyId);
});
