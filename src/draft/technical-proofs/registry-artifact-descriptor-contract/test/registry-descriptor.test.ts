import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  LISTING_KINDS,
  canonicalJson,
  createFixtureDescriptor,
  deserializeDescriptor,
  parseInterfaceRef,
  parseDescriptor,
  serializeDescriptor
} from "../src/registry-descriptor.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("registry descriptor validates and round-trips one fixture per listing kind", () => {
  for (const kind of LISTING_KINDS) {
    const descriptor = createFixtureDescriptor({ kind });
    const parsed = parseDescriptor(descriptor);

    assert.equal(parsed.ok, true, parsed.errors.join("\n"));
    assert.equal(parsed.descriptor.kind, kind);
    assert.equal(
      serializeDescriptor(parsed.descriptor),
      canonicalJson(parsed.descriptor)
    );
    assert.deepEqual(deserializeDescriptor(serializeDescriptor(parsed.descriptor)).descriptor, parsed.descriptor);
  }
});

test("schema and typed bindings publish the descriptor contract surface", async () => {
  const schemaText = await readFile(
    path.join(packageRoot, "schema", "registry.descriptor.v1.schema.json"),
    "utf8"
  );
  const typeDeclarations = await readFile(
    path.join(packageRoot, "src", "registry-descriptor.d.ts"),
    "utf8"
  );

  const schema = JSON.parse(schemaText);
  assert.equal(schema.$id, "https://schemas.hobo.dev/registry.descriptor.v1.schema.json");
  assert.deepEqual(schema.properties.kind.enum, LISTING_KINDS);
  assert.match(typeDeclarations, /export interface RegistryDescriptor/);
  assert.match(typeDeclarations, /export type ListingKind/);
});

test("invalid descriptors fail closed with precise errors", () => {
  const descriptor = createFixtureDescriptor({ kind: "provider" });
  descriptor.artifact = {
    mediaType: "application/vnd.hobo.registry.listing.layer.v1+json",
    tag: "latest"
  };
  descriptor.interfaces.exports[0].ref = "wasi:blobstore/blobstore@stable";
  descriptor.kind = "marketplace-plugin";

  const parsed = parseDescriptor(descriptor);

  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join("\n"), /unknown listing kind marketplace-plugin/);
  assert.match(parsed.errors.join("\n"), /artifact\.digest must be sha256/);
  assert.match(parsed.errors.join("\n"), /artifact\.uri must be an OCI digest reference/);
  assert.match(parsed.errors.join("\n"), /artifact\.tag is not allowed/);
  assert.match(parsed.errors.join("\n"), /interfaces\.exports\.0\.ref must be interface@semver@stability/);
});

test("artifact references reject inlined payloads and stay digest-only", () => {
  const descriptor = createFixtureDescriptor({ kind: "resource-pack" });
  descriptor.evidence.slsaProvenanceRef.payload = { builder: "inline-material" };

  const parsed = parseDescriptor(descriptor);

  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join("\n"), /evidence\.slsaProvenanceRef\.payload is not allowed/);
});

test("declared interface strings parse into manifest-style interface semver stability triples", () => {
  const descriptor = createFixtureDescriptor({ kind: "bindle" });
  const conformanceReport = {
    suite: "@hobo/conformance/blobstore",
    suiteVersion: "0.2.0",
    ref: {
      mediaType: "application/vnd.hobo.conformance.report.v1+json",
      uri: "oci://registry.example/hobo/blobstore-conformance@sha256:1111111111111111111111111111111111111111111111111111111111111111",
      digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
    }
  };
  descriptor.interfaces.imports.push({
    ref: "wasi:blobstore/blobstore@0.2.0@stable",
    conformanceSuite: "@hobo/conformance/blobstore",
    conformanceSuiteVersion: "0.2.0",
    conformanceReportRef: conformanceReport.ref
  });
  descriptor.evidence.conformanceReportRefs.push(conformanceReport);

  const parsed = parseDescriptor(descriptor);

  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  assert.deepEqual(parseInterfaceRef("wasi:blobstore/blobstore@0.2.0@stable"), {
    interface: "wasi:blobstore/blobstore",
    semver: "0.2.0",
    stability: "stable"
  });
  assert.deepEqual(parsed.parsedInterfaces.imports[0], {
    interface: "wasi:blobstore/blobstore",
    semver: "0.2.0",
    stability: "stable"
  });
});

test("stable listings with stale conformance report versions are flagged", () => {
  const descriptor = createFixtureDescriptor({ kind: "provider" });
  descriptor.interfaces.exports[0].conformanceSuiteVersion = "1.0.0";
  descriptor.evidence.conformanceReportRefs[0].suiteVersion = "0.9.0";

  const parsed = parseDescriptor(descriptor);

  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join("\n"), /suiteVersion must match conformanceSuiteVersion/);
});

test("semver parsing accepts full semver and rejects leading-zero versions", () => {
  const descriptor = createFixtureDescriptor({ kind: "provider" });
  descriptor.version = "1.2.3-alpha.1+build.7";
  descriptor.interfaces.exports[0].ref = "hobo:provider/contract@1.2.3-alpha.1+build.7@preview";
  descriptor.evidence.conformanceReportRefs[0].suiteVersion = "0.9.0";

  const parsed = parseDescriptor(descriptor);

  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  assert.equal(parseInterfaceRef("hobo:provider/contract@01.2.3@stable"), null);
  assert.equal(parseDescriptor({ ...descriptor, version: "01.2.3" }).ok, false);
});
