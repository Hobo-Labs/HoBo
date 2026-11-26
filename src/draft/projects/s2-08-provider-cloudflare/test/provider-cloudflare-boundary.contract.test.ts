import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
  createHelloBindlePlan,
  parsePublishedManifest,
  publishCapabilityManifest,
} from "../src/index.js";
import { createCloudflareProvider, realizeCloudflarePlan } from "../../../technical-proofs/provider-cloudflare-contract/src/provider-cloudflare.js";

const pactPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "contracts",
  "provider-cloudflare-boundary.pact.json",
);

describe("ProviderCloudflareBoundary pact", () => {
  it("loads consumer/provider names and manifest publish satisfies the boundary contract", () => {
    const pact = JSON.parse(readFileSync(pactPath, "utf8"));
    const published = publishCapabilityManifest();
    const parsed = parsePublishedManifest(published);

    assert.equal(pact.consumer.name, "@hobo/runtime");
    assert.equal(pact.provider.name, "ProviderCloudflareBoundary");
    assert.equal(pact.interactions[0]?.response.body.ok, true);
    assert.equal(parsed.ok, true);
    assert.deepEqual(Object.keys(published).sort(), pact.interactions[0]?.response.body.paths.sort());
  });

  it("realize hello-bindle satisfies the boundary contract resource ids", () => {
    const pact = JSON.parse(readFileSync(pactPath, "utf8"));
    const provider = createCloudflareProvider();
    const emission = realizeCloudflarePlan(provider, createHelloBindlePlan());

    assert.equal(pact.interactions[1]?.response.body.ok, true);
    assert.deepEqual(
      emission.iac.nodes.map((node) => node.id).sort(),
      pact.interactions[1]?.response.body.resourceIds.sort(),
    );
  });
});
