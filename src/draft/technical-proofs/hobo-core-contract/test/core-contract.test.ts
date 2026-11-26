import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

import {
  CAPABILITY_MANIFEST_SCHEMA_ID,
  CORE_API_SNAPSHOT,
  CORE_SCHEMA_VERSION,
  createContainer,
  createEventEnvelope,
  createPortDescriptor,
  fromCloudEvent,
  parseCapabilityManifestBundle,
  parseEventEnvelope,
  assertCoreApiSnapshot,
  toCloudEvent,
  toOcsfAuditEvent,
  toOtlpSpan,
  validatePublicTypeSurface,
} from "../src/core-contract.js";

function providerManifest(overrides = {}) {
  return {
    index: {
      schemaVersion: CORE_SCHEMA_VERSION,
      issuer: "https://acme-cloud.example.com",
      manifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      signature: {
        alg: "HOBO-FIXTURE-SHA256",
        keyId: "acme-provider-key",
        digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      files: ["capabilities.json", "auth.json", "cost.json"],
    },
    capabilities: {
      ports: [
        { port: "compute", kinds: ["container", "function"], stability: "stable" },
        { port: "database", kinds: ["postgres"], stability: "stable" },
      ],
      regions: ["us-east-1", "us-west-2"],
      equivalenceClasses: ["container", "postgres"],
    },
    auth: {
      issuer: "https://acme-cloud.example.com",
      flows: [
        {
          type: "oidc-federation",
          audience: "hobo",
          exchange: "sts:AssumeRoleWithWebIdentity",
          trust: {
            oidcDiscovery: "https://yard.example.com/.well-known/openid-configuration",
          },
        },
        {
          type: "api-key",
          header: "X-Api-Key",
          rotation: "manual",
        },
      ],
      scopeModel: "least-privilege-per-resource",
      resourceIndicators: ["urn:acme:compute", "urn:acme:database"],
      tokenLifetimeSec: 3600,
      audit: {
        events: ["token.Granted", "token.Used"],
      },
    },
    cost: {
      currency: "USD",
      unitPrices: {
        "compute.container.vcpu-hour": { unit: "hour", amount: 0.04, regions: ["us-east-1"] },
      },
      freeTier: [{ meter: "compute.container.vcpu-hour", amount: 10, resetWindow: "P1M" }],
    },
    ...overrides,
  };
}

describe("@hobo/core shared contract surface", () => {
  it("round-trips the Capability Manifest bundle and rejects unsafe auth/capability shapes", async () => {
    const schema = JSON.parse(
      await readFile(new URL("../schema/capability-manifest-bundle.v1.schema.json", import.meta.url), "utf8"),
    );

    assert.equal(schema.$id, CAPABILITY_MANIFEST_SCHEMA_ID);
    assert.equal(schema.properties.index.properties.schemaVersion.const, CORE_SCHEMA_VERSION);
    assert.deepEqual(schema.required, ["index", "capabilities", "auth", "cost"]);

    const manifest = parseCapabilityManifestBundle(providerManifest(), {
      trustedIssuer: "https://acme-cloud.example.com",
      trustedOidcDiscoveryHost: "yard.example.com",
    });

    assert.equal(manifest.index.issuer, "https://acme-cloud.example.com");
    assert.deepEqual(manifest.capabilities.ports.map((port) => port.port), ["compute", "database"]);
    assert.equal(manifest.auth.flows[0].type, "oidc-federation");
    assert.equal(manifest.cost.currency, "USD");

    assert.throws(
      () =>
        parseCapabilityManifestBundle(
          providerManifest({
            auth: {
              ...providerManifest().auth,
              flows: [{ type: "api-key", rotation: "manual" }],
            },
          }),
        ),
      /api-key header/,
    );

    assert.throws(
      () =>
        parseCapabilityManifestBundle(
          providerManifest({
            capabilities: {
              ...providerManifest().capabilities,
              ports: [{ port: "database", kinds: [], stability: "stable" }],
            },
          }),
        ),
      /kinds/,
    );
  });

  it("publishes port descriptors, EventEnvelope mappings, and a minimal DI container", () => {
    const runtimePort = createPortDescriptor({
      kind: "runtime",
      name: "EventStore",
      interface: "hobo:runtime/event-store@0.1.0",
      stability: "stable",
    });
    const providerPort = createPortDescriptor({
      kind: "provider",
      name: "CloudProvider",
      interface: "hobo:provider/cloud@0.1.0",
      stability: "preview",
    });
    const envelope = createEventEnvelope({
      id: "evt-1",
      type: "identity.Issued",
      tenant: "tenant-acme",
      streamId: "identity/svid-agent-1",
      seq: 7,
      ts: "2026-06-25T12:00:00.000Z",
      actor: { kind: "agent", id: "agent:release" },
      correlationId: "corr-1",
      causationId: "cmd-1",
      data: { identityId: "svid-agent-1", svidRef: "identity://svid/agent-1" },
      meta: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
    });
    const container = createContainer();

    container.register(runtimePort, { append: () => "ok" });
    container.register(providerPort, { realize: () => "preview" });

    assert.equal(container.resolve(runtimePort).append(), "ok");
    assert.equal(container.resolve(providerPort).realize(), "preview");
    assert.throws(() => container.register(runtimePort, {}), /already registered/);

    const cloudEvent = toCloudEvent(envelope);
    assert.deepEqual(fromCloudEvent(cloudEvent), envelope);
    assert.equal(cloudEvent.type, "identity.Issued");
    assert.equal(cloudEvent.hoboseq, 7);

    const ocsf = toOcsfAuditEvent(envelope);
    assert.equal(ocsf.class_name, "Authentication");
    assert.equal(ocsf.metadata.product.name, "HoBo");
    assert.equal(JSON.stringify(ocsf).includes("svidRef"), false);
    assert.throws(
      () => createEventEnvelope({ ...envelope, id: "evt-missing-ts", ts: undefined }),
      /ts must be a non-empty string/,
    );

    const otlp = toOtlpSpan(envelope);
    assert.equal(otlp.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal(otlp.attributes["hobo.event_type"], "identity.Issued");
    assert.deepEqual(parseEventEnvelope(envelope), envelope);
  });

  it("pins the public API snapshot and rejects accidental provider leakage", async () => {
    const declaration = await readFile(new URL("../src/core-contract.d.ts", import.meta.url), "utf8");

    assert.deepEqual(CORE_API_SNAPSHOT.exports, [
      "CapabilityManifestBundle",
      "Container",
      "EventEnvelope",
      "PortDescriptor",
      "ProviderPort",
      "RuntimePort",
    ]);
    assert.deepEqual(assertCoreApiSnapshot(CORE_API_SNAPSHOT), CORE_API_SNAPSHOT);
    assert.equal(validatePublicTypeSurface(declaration).ok, true);

    assert.throws(
      () =>
        assertCoreApiSnapshot({
          ...CORE_API_SNAPSHOT,
          exports: CORE_API_SNAPSHOT.exports.filter((name) => name !== "ProviderPort"),
        }),
      /public API snapshot drift/,
    );

    assert.match(
      validatePublicTypeSurface("export interface AwsProviderSecret { accessKeyId: string }").errors.join("\n"),
      /provider-specific symbol leak/i,
    );
  });
});
