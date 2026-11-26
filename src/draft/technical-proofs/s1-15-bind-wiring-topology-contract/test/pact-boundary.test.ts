import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPact = JSON.parse(
  readFileSync(
    join(here, "../architecture/pacts/bind_wiring_manifest_lowerer.pact.json"),
    "utf8",
  ),
);
const runtimePact = JSON.parse(
  readFileSync(
    join(here, "../architecture/pacts/local_runtime_binding_resolver.pact.json"),
    "utf8",
  ),
);

describe("pact boundary fixtures", () => {
  it("pins bindles manifest lowerer interaction", () => {
    assert.equal(manifestPact.consumer.name, "S1_15BindWiringTopologyConsumer");
    assert.equal(manifestPact.provider.name, "ManifestWiringLowerer");
    assert.equal(manifestPact.interactions[0].response.body.schema, "hobo.manifest/v1");
    assert.ok(manifestPact.interactions[0].response.body.links);
  });

  it("pins camps runtime-local binding resolver interaction", () => {
    assert.equal(runtimePact.consumer.name, "S1_15CampsBindingResolverConsumer");
    assert.equal(runtimePact.provider.name, "RuntimeLocalHarness");
    assert.equal(
      runtimePact.interactions[0].providerStates[0].name,
      "local equivalents registered for sample resources",
    );
  });
});
