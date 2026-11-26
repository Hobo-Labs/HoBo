import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { compileBindleManifest, data, service } from "../src/bind-reference.js";
import {
  createLocalBindingResolver,
  HELLO_BINDLE_LOCAL_ENDPOINTS,
} from "../src/local-binding-resolver.js";
import { canonicalManifestHash, resolveLocalBindings } from "../src/resolve-local-bindings.js";
import { bindle, camp, providerSelection } from "../src/topology.js";

const localRuntime = Object.freeze({ kind: "runtime", id: "runtime-local" });

describe("resolveLocalBindings", () => {
  it("resolves lazy tokens for a local camp", async () => {
    const db = data("db");
    const api = service("api", { bind: { db } });
    const manifest = compileBindleManifest([db, api]);
    const appBindle = bindle("shop", (collector) => {
      collector.use({
        kind: "data",
        name: "db",
        stableId: "data:db",
        portRef: ["hobo:data"],
      });
      collector.use({
        kind: "service",
        name: "api",
        stableId: "service:api",
        portRef: ["wasi:http"],
      });
    });
    const devCamp = camp("dev", {
      bindle: appBindle,
      runtime: localRuntime,
      defaultProvider: providerSelection("local"),
    });
    const resolver = createLocalBindingResolver(HELLO_BINDLE_LOCAL_ENDPOINTS);
    const env = await resolveLocalBindings(manifest, devCamp, resolver);

    assert.equal(env.ConnectionStrings__db, HELLO_BINDLE_LOCAL_ENDPOINTS.db.connectionString);
    assert.match(env.ConnectionStrings__db!, /^sqlite:\/\//);
  });

  it("rejects non-local camp provider", async () => {
    const db = data("db");
    const api = service("api", { bind: { db } });
    const manifest = compileBindleManifest([db, api]);
    const appBindle = bindle("shop", (collector) => {
      collector.use({
        kind: "data",
        name: "db",
        stableId: "data:db",
        portRef: ["hobo:data"],
      });
    });
    const awsCamp = camp("prod", {
      bindle: appBindle,
      runtime: localRuntime,
      defaultProvider: providerSelection("aws"),
    });
    const resolver = createLocalBindingResolver(HELLO_BINDLE_LOCAL_ENDPOINTS);

    await assert.rejects(
      () => resolveLocalBindings(manifest, awsCamp, resolver),
      /resolveLocalBindings requires local provider/,
    );
  });

  it("rejects unknown resource bindings", async () => {
    const db = data("db");
    const api = service("api", { bind: { db } });
    const manifest = compileBindleManifest([db, api]);
    const appBindle = bindle("shop", (collector) => {
      collector.use({
        kind: "data",
        name: "db",
        stableId: "data:db",
        portRef: ["hobo:data"],
      });
    });
    const devCamp = camp("dev", {
      bindle: appBindle,
      runtime: localRuntime,
      defaultProvider: providerSelection("local"),
    });
    const resolver = createLocalBindingResolver({});

    await assert.rejects(
      () => resolveLocalBindings(manifest, devCamp, resolver),
      /unknown binding db\.connectionString/,
    );
  });

  it("FR-004: same bindle manifest hash across camps with different provider mappings", () => {
    const db = data("db");
    const api = service("api", { bind: { db } });
    const manifest = compileBindleManifest([db, api]);
    const hash = canonicalManifestHash(manifest);

    const appBindle = bindle("shop", (collector) => {
      collector.use({
        kind: "data",
        name: "db",
        stableId: "data:db",
        portRef: ["hobo:data"],
      });
      collector.use({
        kind: "service",
        name: "api",
        stableId: "service:api",
        portRef: ["wasi:http"],
      });
    });

    const localCamp = camp("dev", {
      bindle: appBindle,
      runtime: localRuntime,
      defaultProvider: providerSelection("local"),
    });
    const awsCamp = camp("dev", {
      bindle: appBindle,
      runtime: localRuntime,
      defaultProvider: providerSelection("aws"),
    });

    assert.equal(localCamp.bindle, appBindle);
    assert.equal(awsCamp.bindle, appBindle);
    assert.equal(canonicalManifestHash(manifest), hash);
    assert.notEqual(localCamp.providerId, awsCamp.providerId);
  });
});
