import assert from "node:assert/strict";
import { test } from "vitest";

import { validateControlPlaneEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import { canonicalManifestHash } from "../../hobo-manifest-contract/src/manifest.js";
import {
  assertPlanManifest,
  canonicalPlanJson,
  createCheckoutProdRegistry,
  createHelloBindleRegistry,
  createUnsatisfiableRequireRegistry,
  loadGoldenFixture,
  loadManifestFixture,
  planManifest,
} from "../src/planner.js";

const productionContext = {
  deploymentId: "deploy-checkout-prod",
  objective: "cost",
  context: {
    envType: "production",
    app: "checkout",
    env: "prod",
    tenant: "tenant-acme",
  },
};

const helloBindleContext = {
  deploymentId: "deploy-hello-bindle-preview",
  objective: "cost",
  context: {
    envType: "ephemeral",
    app: "hello-bindle",
    env: "preview",
    tenant: "tenant-hobo",
  },
};

test("hello-bindle manifest plans deterministically with recorded rationale", async () => {
  const manifest = await loadManifestFixture("hello-bindle");
  const registry = createHelloBindleRegistry();
  const first = assertPlanManifest(manifest, helloBindleContext, registry);
  const second = assertPlanManifest(manifest, helloBindleContext, registry);

  assert.equal(first.planHash, second.planHash);
  assert.equal(first.deploymentPlan.resources.length, 1);
  assert.equal(first.deploymentPlan.resources[0].id, "service");
  assert.equal(first.deploymentPlan.resources[0].provider.definitionId, "local-wasm-http");
  assert.equal(first.plannedEvent.type, "deployment.Planned");
  assert.equal(first.matchEvents.length, 1);
  assert.equal(first.deploymentPlan.meta.rationale[0].winner, "local-wasm-http");
  assert.equal(validateControlPlaneEvent(first.plannedEvent).ok, true);
  assert.equal(canonicalManifestHash(manifest), first.sourceManifestHash);
});

test("checkout-prod golden IR replays byte-identical DeploymentPlan", async () => {
  const manifest = await loadManifestFixture("checkout-prod");
  const registry = createCheckoutProdRegistry();
  const result = assertPlanManifest(manifest, productionContext, registry);
  const golden = await loadGoldenFixture("checkout-prod.plan");

  assert.equal(result.planHash, golden.planHash);
  assert.equal(canonicalPlanJson(result.deploymentPlan), canonicalPlanJson(golden.deploymentPlan));
  assert.deepEqual(
    result.deploymentPlan.resources.map((resource) => resource.provider.definitionId),
    ["aws-rds-postgres", "azure-container-http", "cloudflare-workers-edge", "local-container-worker"],
  );
  assert.deepEqual(
    result.deploymentPlan.resources.map((resource) => resource.id),
    ["orders-db", "checkout-api", "web-edge", "receipt-worker"],
  );
  assert.equal(result.matchEvents.length, 4);
  assert.equal(result.deploymentPlan.meta.provenance.matchDecisionIds.length, 4);
});

test("seeded unsatisfiable require rejects with fixture deployment.PlanRejected reason", async () => {
  const manifest = await loadManifestFixture("unsatisfiable-require");
  const registry = createUnsatisfiableRequireRegistry();
  const result = planManifest(manifest, productionContext, registry);
  const golden = await loadGoldenFixture("unsatisfiable-require.rejection");

  assert.equal(result.ok, false);
  assert.equal(result.planRejectedEvent.type, "deployment.PlanRejected");
  assert.equal(result.reason, golden.reason);
  assert.equal(result.rejection?.code, golden.rejection.code);
  assert.equal(validateControlPlaneEvent(result.planRejectedEvent).ok, true);
  assert.match(result.planRejectedEvent.data.reason, /containerService\.http2/);
});

test("adversarial cyclic manifest dependency is rejected before provider resolution", async () => {
  const manifest = await loadManifestFixture("checkout-prod");
  manifest.resources["orders-db"].bind = ["web-edge"];

  assert.throws(
    () => planManifest(manifest, productionContext, createCheckoutProdRegistry()),
    /dependency cycle/,
  );
});
