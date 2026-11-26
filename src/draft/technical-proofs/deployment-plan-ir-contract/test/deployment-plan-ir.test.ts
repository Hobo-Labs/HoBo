import assert from "node:assert/strict";
import { test } from "vitest";

import {
  canonicalJson,
  createFixtureDeploymentPlan,
  outputPlaceholder,
  parsePlaceholder,
  planContentAddress,
  validateDeploymentPlan
} from "../src/deployment-plan-ir.js";

test("fixture DeploymentPlan validates and content-addresses deterministically", () => {
  const plan = createFixtureDeploymentPlan();
  const validation = validateDeploymentPlan(plan);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(canonicalJson(plan), canonicalJson(createFixtureDeploymentPlan()));
  assert.equal(
    planContentAddress(plan),
    "sha256:d161b41cb1099d122c86a1ea7678725752b0a36312901acc6df698180c9badb4"
  );
  assert.deepEqual(
    plan.resources.map((resource) => resource.id),
    ["assets", "assets-read-policy", "api"]
  );
  assert.equal(plan.resources.find((resource) => resource.id === "assets-read-policy").coProvisionedFor, "assets");
  assert.equal(plan.meta.objective, "cost");
  assert.deepEqual(plan.resources[0].context, {
    envType: "ephemeral",
    app: "gallery",
    env: "preview",
    tenant: "tenant-acme",
    resourceType: "objectStore",
    resourceClass: "standard",
    resourceId: "assets"
  });
});

test("placeholder parser accepts resource output and context grammar", () => {
  assert.deepEqual(
    parsePlaceholder("${resources.objectStore.standard#assets.outputs.bucketName}"),
    {
      kind: "resource-output",
      type: "objectStore",
      className: "standard",
      id: "assets",
      output: "bucketName"
    }
  );
  assert.deepEqual(parsePlaceholder("${context.envType}"), {
    kind: "context",
    field: "envType"
  });

  assert.throws(
    () => parsePlaceholder("${resources.objectStore#assets.outputs.bucketName}"),
    /invalid placeholder/
  );
  assert.throws(() => parsePlaceholder("${context.region}"), /unsupported context field region/);
});

test("unresolved placeholder refs fail planning with precise errors", () => {
  const plan = createFixtureDeploymentPlan();
  plan.resources.find((resource) => resource.id === "api").inputs.env.ASSETS_BUCKET =
    outputPlaceholder({
      type: "objectStore",
      className: "standard",
      id: "assets",
      output: "missingBucket"
    });

  const validation = validateDeploymentPlan(plan);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /placeholder .* references missing output missingBucket/);
});

test("merged options retain only the resolved provider block", () => {
  const plan = createFixtureDeploymentPlan();
  plan.resources.find((resource) => resource.id === "assets").options.providerOptions.azure = {
    storageAccountSku: "Standard_LRS"
  };

  const validation = validateDeploymentPlan(plan);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /unresolved provider option block azure/);
});

test("dependency DAG cycles are rejected", () => {
  const plan = createFixtureDeploymentPlan();
  plan.resources.find((resource) => resource.id === "assets").deps.push("api");

  const validation = validateDeploymentPlan(plan);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /dependency cycle: assets -> api -> assets/);
});

test("co-provisioned node id collisions fail closed", () => {
  const plan = createFixtureDeploymentPlan();
  plan.resources.push({
    ...plan.resources.find((resource) => resource.id === "assets-read-policy"),
    id: "assets"
  });

  const validation = validateDeploymentPlan(plan);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /duplicate resource id assets/);
  assert.match(validation.errors.join("\n"), /co-provisioned node assets collides with parent assets/);
});
