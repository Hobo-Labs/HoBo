import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import {
  buildHelloBindleManifest,
  buildHelloBindleTopology,
  localEndpointForDb,
} from "../src/hello-bindle.js";
import {
  createLocalBindingResolver,
  HELLO_BINDLE_LOCAL_ENDPOINTS,
} from "../src/local-binding-resolver.js";
import { canonicalManifestHash, resolveLocalBindings } from "../src/resolve-local-bindings.js";

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, "../fixtures/manifests/hello-bindle.manifest.json");

describe("hello-bindle wiring e2e", () => {
  it("collects golden manifest with links and lazy token", () => {
    const manifest = buildHelloBindleManifest();

    assert.deepEqual(manifest.resources.api?.links, [{ import: "hobo:data", to: "db" }]);
    assert.equal(manifest.resources.api?.env?.ConnectionStrings__db, "{db.connectionString}");
    assert.equal(manifest.resources.worker?.env?.ConnectionStrings__db, "{db.connectionString}");
    assert.equal(manifest.resources.worker?.env?.LOG_LEVEL, "debug");
    assert.ok(manifest.resources.worker?.endpoints?.http);

    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(goldenPath, serialized);
    }
    const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
    assert.deepEqual(manifest, golden);
    assert.ok(canonicalManifestHash(manifest).startsWith("sha256:"));
  });

  it("resolves runtime-local endpoint offline for hello-bindle", async () => {
    const { manifest, devCamp } = buildHelloBindleTopology();
    const resolver = createLocalBindingResolver(HELLO_BINDLE_LOCAL_ENDPOINTS);
    const env = await resolveLocalBindings(manifest, devCamp, resolver);

    assert.equal(env.ConnectionStrings__db, localEndpointForDb());
    assert.match(env.ConnectionStrings__db!, /^sqlite:\/\//);
    assert.doesNotMatch(env.ConnectionStrings__db!, /^\{/);
  });

  it("hello-bindle bindle stays provider-agnostic", () => {
    const { bindle: appBindle, localYard } = buildHelloBindleTopology();
    const serialized = JSON.stringify({ appBindle, localYard });

    assert.equal(/aws|azure|gcp|cloudflare/i.test(serialized), false);
    assert.equal(appBindle.providerAgnostic, true);
    assert.equal(localYard.providerId, "local");
  });
});
