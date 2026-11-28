import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  bindle,
  camp,
  providerSelection,
  resolutionPrecedenceFor,
  yard,
} from "../src/topology.js";

function resource(kind: string, name: string, portRef: readonly string[] = [`hobo:${kind}`]) {
  return Object.freeze({
    kind,
    name,
    stableId: `${kind}:${name}`,
    portRef,
    toDescriptor() {
      return {
        kind,
        name,
        stableId: `${kind}:${name}`,
        portRef,
      };
    },
  });
}

const localRuntime = Object.freeze({ kind: "runtime", id: "runtime-local" });
const awsDefault = providerSelection("aws", "default");
const awsCompute = providerSelection("aws", "app-runner", { tier: "paas" });
const awsData = providerSelection("aws", "rds", { resource: "shop.db" });
const localDefault = providerSelection("local", "default");

describe("topology objects", () => {
  it("programmatic bindle, camp, and yard compose without config files", () => {
    const shop = bindle("shop", (collector) => {
      collector.use(resource("data", "db"));
      collector.use(resource("service", "api", ["wasi:http"]));
    });

    const prod = camp("prod", {
      bindle: shop,
      envType: "production",
      runtime: localRuntime,
      defaultProvider: awsDefault,
    });
    const awsYard = yard("aws", { camps: [prod] });

    assert.equal(shop.kind, "bindle");
    assert.equal(shop.source, "programmatic");
    assert.equal(shop.configFile, false);
    assert.equal(shop.providerAgnostic, true);
    assert.deepEqual(
      shop.resources.map((entry) => entry.stableId),
      ["data:db", "service:api"],
    );
    assert.deepEqual(shop.providerIds, []);
    assert.equal(JSON.stringify(shop).includes("aws"), false);

    assert.equal(prod.id, "prod-aws");
    assert.equal(prod.env, "prod");
    assert.equal(prod.envType, "production");
    assert.equal(prod.providerId, "aws");
    assert.equal(prod.bindle.name, "shop");

    assert.equal(awsYard.providerId, "aws");
    assert.deepEqual(
      awsYard.camps.map((entry) => entry.id),
      ["prod-aws"],
    );
  });

  it("camp id normalizes to env-provider form and keeps environment type", () => {
    const app = bindle("api", (collector) => {
      collector.use(resource("service", "api"));
    });

    const explicitEnv = camp("staging-aws", {
      bindle: app,
      envType: "staging",
      runtime: localRuntime,
      defaultProvider: awsDefault,
    });
    const inferredEnvType = camp("preview", {
      bindle: app,
      runtime: localRuntime,
      defaultProvider: awsDefault,
    });

    assert.equal(explicitEnv.id, "staging-aws");
    assert.equal(explicitEnv.env, "staging");
    assert.equal(explicitEnv.envType, "staging");
    assert.equal(inferredEnvType.id, "preview-aws");
    assert.equal(inferredEnvType.env, "preview");
    assert.equal(inferredEnvType.envType, "ephemeral");
  });

  it("resolution precedence records bindings before tiers before defaultProvider", () => {
    const app = bindle("shop", (collector) => {
      collector.use(resource("data", "db", ["hobo:sql"]));
      collector.use(resource("service", "api", ["wasi:http"]));
    });

    const prod = camp("prod", {
      bindle: app,
      envType: "production",
      runtime: localRuntime,
      defaultProvider: awsDefault,
      tiers: { service: awsCompute },
      bindings: { "shop.db": awsData },
    });

    assert.deepEqual(prod.resolutionOrder, ["bindings", "tiers", "defaultProvider"]);
    assert.deepEqual(
      prod.resolutionPrecedence.find(
        (entry) => entry.resource === "data:db" && entry.portRef === "hobo:sql",
      ),
      {
        resource: "data:db",
        resourceName: "db",
        resourceKind: "data",
        portRef: "hobo:sql",
        order: [
          { source: "bindings", key: "shop.db", providerId: "aws", selector: "rds" },
          { source: "tiers", key: "data", providerId: null, selector: null },
          { source: "defaultProvider", key: "*", providerId: "aws", selector: "default" },
        ],
      },
    );
    assert.deepEqual(resolutionPrecedenceFor(prod, "shop.db"), [
      { source: "bindings", key: "shop.db", providerId: "aws", selector: "rds" },
      { source: "tiers", key: "data", providerId: null, selector: null },
      { source: "defaultProvider", key: "*", providerId: "aws", selector: "default" },
    ]);
  });

  it("yard rejects camps from different providers", () => {
    const app = bindle("api", (collector) => {
      collector.use(resource("service", "api"));
    });
    const awsCamp = camp("prod", {
      bindle: app,
      envType: "production",
      runtime: localRuntime,
      defaultProvider: providerSelection("aws", "default"),
    });
    const azureCamp = camp("prod", {
      bindle: app,
      envType: "production",
      runtime: localRuntime,
      defaultProvider: providerSelection("azure", "default"),
    });

    assert.throws(
      () => yard("mixed", { camps: [awsCamp, azureCamp] }),
      /Yard mixed cannot mix providers/,
    );
  });

  it("bindle rejects provider-specific options at app scope", () => {
    assert.throws(
      () =>
        bindle("leaky", (collector) =>
          collector.use({
            kind: "data",
            name: "db",
            stableId: "data:db",
            portRef: ["hobo:data"],
            providerAnnotations: { "aws.rds": { multiAz: true } },
          }),
        ),
      /provider-specific options belong on Camp mappings/,
    );
  });

  it("camp without runtime is rejected", () => {
    const app = bindle("api", (collector) => {
      collector.use(resource("service", "api"));
    });
    assert.throws(
      () =>
        // SAFETY: assertion to `camp("dev", {` is required at this boundary.
        camp("dev", {
          bindle: app,
          defaultProvider: localDefault,
        } as never),
      /camp requires a runtime backend descriptor/,
    );
  });

  it("camp rejects mixed provider mappings", () => {
    const app = bindle("api", (collector) => {
      collector.use(resource("service", "api"));
    });
    assert.throws(
      () =>
        camp("dev", {
          bindle: app,
          runtime: localRuntime,
          defaultProvider: providerSelection("local", "default"),
          tiers: { service: providerSelection("aws", "default") },
        }),
      /camp mappings must target one provider/,
    );
  });
});
