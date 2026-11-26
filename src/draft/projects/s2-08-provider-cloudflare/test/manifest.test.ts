import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  INITIAL_CAPABILITY_PORTS,
  createProviderCloudflareDraft,
  equivalenceForPort,
  parsePublishedManifest,
  publishCapabilityManifest,
} from "../src/index.js";

describe("Capability Manifest publication (FR-031)", () => {
  it("publishes capabilities, auth, and cost.json under /.well-known/capability-manifest/", () => {
    const documents = publishCapabilityManifest();
    const parsed = parsePublishedManifest(documents);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.auth.schema, "hobo.provider-auth/v1");
    assert.equal(parsed.cost.schema, "hobo.cost/v1");
    assert.equal(parsed.capabilities.capabilities.length, 3);
    assert.deepEqual(
      parsed.capabilities.capabilities.map((c: { port: string }) => c.port).sort(),
      ["compute", "kv", "objectStore"],
    );
  });

  it("rejects manifests that publish static secrets", () => {
    const documents = publishCapabilityManifest();
    const auth = JSON.parse(documents["/.well-known/capability-manifest/auth.json"]);
    auth.staticKey = "secret";
    documents["/.well-known/capability-manifest/auth.json"] = `${JSON.stringify(auth, null, 2)}\n`;
    const parsed = parsePublishedManifest(documents);

    assert.equal(parsed.ok, false);
    assert.ok(parsed.errors.includes("auth must not publish static secrets"));
  });
});

describe("Equivalence-class mappings", () => {
  it("maps web/service, kv, and objectStore to Cloudflare resource classes", () => {
    assert.equal(equivalenceForPort("web/service").resourceClass, "cloudflare:workers-script");
    assert.equal(equivalenceForPort("kv").resourceClass, "cloudflare:kv-namespace");
    assert.equal(equivalenceForPort("objectStore").resourceClass, "cloudflare:r2-bucket");
    assert.deepEqual(INITIAL_CAPABILITY_PORTS, ["web/service", "kv", "objectStore"]);
  });
});

describe("Provider factory", () => {
  it("covers all initial ports via claimed capabilities", () => {
    const provider = createProviderCloudflareDraft();
    for (const port of INITIAL_CAPABILITY_PORTS) {
      assert.equal(provider.coversInitialPort(port), true);
    }
  });
});
