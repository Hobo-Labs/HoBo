import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_SPEC_SCHEMA,
  createFixtureCapabilitySpec,
  parseCapabilitySpec,
  resolveAvailability
} from "../src/capability-spec.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("fixture specs resolve stable, preview, and unavailable interfaces deterministically", () => {
  const stableProvider = createFixtureCapabilitySpec({
    providerId: "acme-stable",
    interfaces: [
      {
        interface: "wasi:blobstore/blobstore",
        semver: "1.0.0",
        stability: "stable",
        suite: "@hobo/conformance/blobstore",
        suiteVersion: "1.0.0"
      }
    ]
  });
  const previewProvider = createFixtureCapabilitySpec({
    providerId: "acme-preview",
    interfaces: [
      {
        interface: "wasi:websocket/websocket",
        semver: "0.1.0-draft.1",
        stability: "preview",
        suite: "@hobo/conformance/websocket",
        suiteVersion: "0.1.0"
      }
    ]
  });

  const used = [
    "wasi:blobstore/blobstore@1.0.0",
    "wasi:websocket/websocket@0.1.0-draft.1",
    "hobo:notify/notify@1.0.0"
  ];

  const first = resolveAvailability(used, [previewProvider, stableProvider]);
  const second = resolveAvailability(used, [previewProvider, stableProvider]);

  assert.deepEqual(first, second);
  assert.equal(first.status, "error");
  assert.equal(first.results[0].status, "ok");
  assert.equal(first.results[1].status, "warn");
  assert.match(first.results[1].message, /pinned, may change/);
  assert.equal(first.results[2].status, "error");
  assert.match(first.results[2].remediation, /register a provider/);
});

test("schema and typed bindings publish the Capability Spec surface", async () => {
  const schemaText = await readFile(
    path.join(packageRoot, "schema", "hobo.capability-spec.v1.schema.json"),
    "utf8"
  );
  const typeDeclarations = await readFile(
    path.join(packageRoot, "src", "capability-spec.d.ts"),
    "utf8"
  );

  const schema = JSON.parse(schemaText);
  assert.equal(CAPABILITY_SPEC_SCHEMA, "hobo.capability-spec/v1");
  assert.equal(schema.$id, "https://schemas.hobo.dev/hobo.capability-spec.v1.schema.json");
  assert.deepEqual(schema.$defs.capabilityDeclaration.properties.stability.enum, [
    "stable",
    "preview",
    "experimental",
    "deprecated"
  ]);
  assert.match(typeDeclarations, /export interface CapabilitySpec/);
  assert.match(typeDeclarations, /export function resolveAvailability/);
});

test("interfaces without matching conformance-suite report versions are rejected", () => {
  const spec = createFixtureCapabilitySpec({
    interfaces: [
      {
        interface: "wasi:keyvalue/store",
        semver: "1.0.0",
        stability: "stable",
        suite: "@hobo/conformance/keyvalue",
        suiteVersion: "1.0.0"
      }
    ]
  });
  spec.reports[0].suiteVersion = "0.9.0";

  const parsed = parseCapabilitySpec(spec);

  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join("\n"), /conformanceReportRef suiteVersion must match conformanceSuiteVersion/);
});

test("stable claims with absent or stale reports are unavailable, not ok", () => {
  const staleSpec = createFixtureCapabilitySpec({
    providerId: "stale-provider",
    interfaces: [
      {
        interface: "wasi:keyvalue/store",
        semver: "1.0.0",
        stability: "stable",
        suite: "@hobo/conformance/keyvalue",
        suiteVersion: "1.0.0"
      }
    ]
  });
  staleSpec.reports = [];

  const result = resolveAvailability(["wasi:keyvalue/store@1.0.0"], [staleSpec]);

  assert.equal(result.status, "error");
  assert.equal(result.results[0].status, "error");
  assert.match(result.results[0].message, /unavailable/);
  assert.match(result.results[0].remediation, /valid conformance report/);
});

test("multiple providers resolve to the highest stability tier", () => {
  const previewProvider = createFixtureCapabilitySpec({
    providerId: "preview-provider",
    interfaces: [
      {
        interface: "wasi:websocket/websocket",
        semver: "0.1.0",
        stability: "preview",
        suite: "@hobo/conformance/websocket",
        suiteVersion: "0.1.0"
      }
    ]
  });
  const stableProvider = createFixtureCapabilitySpec({
    providerId: "stable-provider",
    interfaces: [
      {
        interface: "wasi:websocket/websocket",
        semver: "0.1.0",
        stability: "stable",
        suite: "@hobo/conformance/websocket",
        suiteVersion: "0.1.0"
      }
    ]
  });

  const result = resolveAvailability(["wasi:websocket/websocket@0.1.0"], [
    previewProvider,
    stableProvider
  ]);

  assert.equal(result.status, "ok");
  assert.equal(result.results[0].status, "ok");
  assert.equal(result.results[0].providerId, "stable-provider");
});

test("incompatible semver is unavailable instead of a silent downgrade", () => {
  const spec = createFixtureCapabilitySpec({
    interfaces: [
      {
        interface: "wasi:websocket/websocket",
        semver: "0.2.0",
        stability: "stable",
        suite: "@hobo/conformance/websocket",
        suiteVersion: "0.2.0"
      }
    ]
  });

  const result = resolveAvailability(["wasi:websocket/websocket@0.1.0"], [spec]);

  assert.equal(result.status, "error");
  assert.equal(result.results[0].status, "error");
  assert.match(result.results[0].message, /incompatible semver/);
});
