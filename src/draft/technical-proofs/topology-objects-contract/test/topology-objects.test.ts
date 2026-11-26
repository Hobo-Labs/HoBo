import assert from "node:assert/strict";
import { test } from "vitest";

import {
  bindle,
  camp,
  junction,
  providerSelection,
  resolutionPrecedenceFor,
  yard
} from "../src/topology-objects.js";

function resource(kind, name, portRef = [`hobo:${kind}`]) {
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
        portRef
      };
    }
  });
}

const awsDefault = providerSelection("aws", "default");
const awsCompute = providerSelection("aws", "app-runner", { tier: "paas" });
const awsData = providerSelection("aws", "rds", { resource: "shop.db" });
const localRuntime = Object.freeze({ kind: "runtime", id: "runtime-local" });

test("programmatic bindle, camp, yard, and junction compose without config files", () => {
  const shop = bindle("shop", (b) => {
    const db = b.use(resource("data", "db"));
    const api = b.use(resource("service", "api", ["wasi:http"]));
    return { db, api };
  });

  const prod = camp("prod", {
    bindle: shop,
    envType: "production",
    runtime: localRuntime,
    defaultProvider: awsDefault
  });
  const awsYard = yard("aws", { camps: [prod] });
  const fleet = junction("shop", { yards: [awsYard] });

  assert.equal(shop.kind, "bindle");
  assert.equal(shop.source, "programmatic");
  assert.equal(shop.configFile, false);
  assert.equal(shop.providerAgnostic, true);
  assert.deepEqual(
    shop.resources.map((entry) => entry.stableId),
    ["data:db", "service:api"]
  );
  assert.deepEqual(shop.providerIds, []);
  assert.equal(JSON.stringify(shop).includes("aws"), false, "Bindle must not leak provider symbols");

  assert.equal(prod.id, "prod-aws");
  assert.equal(prod.env, "prod");
  assert.equal(prod.envType, "production");
  assert.equal(prod.providerId, "aws");
  assert.equal(prod.bindle.name, "shop");

  assert.equal(awsYard.providerId, "aws");
  assert.deepEqual(awsYard.camps.map((entry) => entry.id), ["prod-aws"]);
  assert.deepEqual(fleet.providerIds, ["aws"]);
  assert.deepEqual(fleet.yards.map((entry) => entry.name), ["aws"]);
});

test("camp id normalizes to env-provider form and keeps environment type", () => {
  const app = bindle("api", (b) => b.use(resource("service", "api")));

  const explicitEnv = camp("staging-aws", {
    bindle: app,
    envType: "staging",
    runtime: localRuntime,
    defaultProvider: awsDefault
  });
  const inferredEnvType = camp("preview", {
    bindle: app,
    runtime: localRuntime,
    defaultProvider: awsDefault
  });

  assert.equal(explicitEnv.id, "staging-aws");
  assert.equal(explicitEnv.env, "staging");
  assert.equal(explicitEnv.envType, "staging");
  assert.equal(inferredEnvType.id, "preview-aws");
  assert.equal(inferredEnvType.env, "preview");
  assert.equal(inferredEnvType.envType, "ephemeral");
});

test("resolution precedence records bindings before tiers before defaultProvider", () => {
  const app = bindle("shop", (b) => {
    b.use(resource("data", "db", ["hobo:sql"]));
    b.use(resource("service", "api", ["wasi:http"]));
  });

  const prod = camp("prod", {
    bindle: app,
    envType: "production",
    runtime: localRuntime,
    defaultProvider: awsDefault,
    tiers: {
      service: awsCompute
    },
    bindings: {
      "shop.db": awsData
    }
  });

  assert.deepEqual(
    prod.resolutionPrecedence.find((entry) => entry.resource === "data:db" && entry.portRef === "hobo:sql"),
    {
      resource: "data:db",
      resourceName: "db",
      resourceKind: "data",
      portRef: "hobo:sql",
      order: [
        { source: "bindings", key: "shop.db", providerId: "aws", selector: "rds" },
        { source: "tiers", key: "data", providerId: null, selector: null },
        { source: "defaultProvider", key: "*", providerId: "aws", selector: "default" }
      ]
    }
  );
  assert.deepEqual(resolutionPrecedenceFor(prod, "shop.db"), [
    { source: "bindings", key: "shop.db", providerId: "aws", selector: "rds" },
    { source: "tiers", key: "data", providerId: null, selector: null },
    { source: "defaultProvider", key: "*", providerId: "aws", selector: "default" }
  ]);
  assert.deepEqual(resolutionPrecedenceFor(prod, "service"), [
    { source: "bindings", key: "api", providerId: null, selector: null },
    { source: "tiers", key: "service", providerId: "aws", selector: "app-runner" },
    { source: "defaultProvider", key: "*", providerId: "aws", selector: "default" }
  ]);
});

test("yard rejects camps from different providers", () => {
  const app = bindle("api", (b) => b.use(resource("service", "api")));
  const awsCamp = camp("prod", {
    bindle: app,
    envType: "production",
    runtime: localRuntime,
    defaultProvider: providerSelection("aws", "default")
  });
  const azureCamp = camp("prod", {
    bindle: app,
    envType: "production",
    runtime: localRuntime,
    defaultProvider: providerSelection("azure", "default")
  });

  assert.throws(() => yard("mixed", { camps: [awsCamp, azureCamp] }), /Yard mixed cannot mix providers/);
});

test("bindle rejects provider-specific options at app scope", () => {
  assert.throws(
    () =>
      bindle("leaky", (b) =>
        b.use({
          kind: "data",
          name: "db",
          stableId: "data:db",
          providerAnnotations: { "aws.rds": { multiAz: true } }
        })
      ),
    /provider-specific options belong on Camp mappings/
  );
  assert.throws(
    () =>
      bindle("leaky-descriptor", (b) =>
        b.use({
          toDescriptor() {
            return {
              kind: "data",
              name: "db",
              stableId: "data:db",
              portRef: ["hobo:sql"],
              providerAnnotations: { "aws.rds": { multiAz: true } }
            };
          }
        })
      ),
    /provider-specific options belong on Camp mappings/
  );
});

test("junction accepts one yard but rejects an empty topology", () => {
  const app = bindle("api", (b) => b.use(resource("service", "api")));
  const prod = camp("prod", {
    bindle: app,
    envType: "production",
    runtime: localRuntime,
    defaultProvider: awsDefault
  });
  const singleCloud = yard("aws", { camps: [prod] });

  assert.equal(junction("single", { yards: [singleCloud] }).kind, "junction");
  assert.throws(() => junction("empty", { yards: [] }), /junction requires at least one Yard/);
});
