import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import {
  lowerManifestToResourceIntents,
  type DeployContext,
  type HoboManifest,
} from "../src/manifest-resource-intent-bridge.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, "..", "fixtures", "plan-spine-manifest.json");

const deployContext: DeployContext = {
  tenant: "acme",
  workspace: "platform",
  environment: "prod",
  routingObjective: "cost",
  budget: {
    amount: 2500,
    currency: "USD",
    period: "monthly",
    softLimitBehavior: "requireApproval",
    hardLimitBehavior: "deny",
  },
};

test("lowers each manifest resource to a provider-neutral ResourceIntent", async () => {
  const manifest = JSON.parse(await readFile(fixturePath, "utf8")) as HoboManifest;
  const intents = lowerManifestToResourceIntents(manifest, deployContext);

  assert.equal(intents.length, 2);
  assert.deepEqual(
    intents.map((intent) => intent.resourceName).sort(),
    ["api", "db"],
  );
});

test("maps manifest port and verbs into capability requirements", async () => {
  const manifest = JSON.parse(await readFile(fixturePath, "utf8")) as HoboManifest;
  const dbIntent = lowerManifestToResourceIntents(manifest, deployContext).find(
    (intent) => intent.resourceName === "db",
  );

  assert.ok(dbIntent);
  assert.equal(dbIntent.capability.category, "hobo:data");
  assert.deepEqual(dbIntent.capability.requirements, [
    "paradigm:relational",
    "verb:query",
  ]);
});

test("derives colocation constraints from bind and links", async () => {
  const manifest = JSON.parse(await readFile(fixturePath, "utf8")) as HoboManifest;
  const apiIntent = lowerManifestToResourceIntents(manifest, deployContext).find(
    (intent) => intent.resourceName === "api",
  );

  assert.ok(apiIntent);
  assert.deepEqual(apiIntent.constraints.colocateWith, ["db"]);
});

test("rejects provider-specific annotation leakage into ResourceIntent", async () => {
  const manifest: HoboManifest = {
    schema: "hobo.manifest/v1",
    resources: {
      leaky: {
        type: "data.v1",
        port: "hobo:data",
        annotations: {
          with: { "aws.rds": { region: "us-east-1" } },
        },
      },
    },
  };

  const intents = lowerManifestToResourceIntents(manifest, deployContext);
  assert.equal(intents[0].resourceName, "leaky");
  assert.equal(JSON.stringify(intents[0]).includes("aws"), false);
  assert.equal(JSON.stringify(intents[0]).includes("us-east-1"), false);
});

test("fails closed on empty manifest resources", () => {
  assert.throws(
    () =>
      lowerManifestToResourceIntents(
        { schema: "hobo.manifest/v1", resources: {} },
        deployContext,
      ),
    /manifest has no resources/,
  );
});
