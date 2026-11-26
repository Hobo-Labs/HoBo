import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  inferPermissionsForSnapshopSource,
  runAnonymousNpxUpScenario,
  runAppDeveloperJourney,
  runBlockedDeployGateScenario,
  runDeclinedCardScenario,
} from "../src/app-dev-journey.js";

async function tempWorkspace() {
  return mkdtemp(join(tmpdir(), "hobo-198-"));
}

test("CI scenario proves hobo new -> dev -> inspect -> up with manifest and live URL", async () => {
  const evidence = await runAppDeveloperJourney({
    workspaceRoot: await tempWorkspace(),
  });

  assert.equal(evidence.commands.new, "hobo new snapshop -t api");
  assert.equal(evidence.commands.dev, "hobo dev");
  assert.equal(evidence.commands.inspect, "hobo inspect run --last");
  assert.equal(evidence.commands.up, "hobo up");
  assert.equal(evidence.scaffold.name, "snapshop");
  assert.equal(evidence.scaffold.template, "api");
  assert.deepEqual(evidence.manifest.resources.catalog.allow, ["get", "set"]);
  assert.deepEqual(evidence.manifest.resources.images.allow, ["read", "write"]);
  assert.deepEqual(evidence.manifest.resources.api.bindings.catalog, {
    port: "wasi:keyvalue",
    resource: "catalog",
    clientType: "KvClient",
  });
  assert.deepEqual(evidence.manifest.resources.api.bindings.images, {
    port: "wasi:blobstore",
    resource: "images",
    clientType: "BucketClient",
  });
  assert.equal(evidence.dev.boot.localUrl, "http://localhost:4100");
  assert.equal(evidence.dev.hotReload.code, "HOBO_DEV_RELOADED");
  assert.equal(evidence.inspect.status, "completed");
  assert.equal(evidence.inspect.steps.total, 2);
  assert.equal(evidence.up.status, "deployed");
  assert.equal(evidence.up.liveUrl, "https://snapshop.prod.hobo.example");
  assert.equal(evidence.cloudSpecificCodeMatches.length, 0);
});

test("killing and restarting hobo dev replays the journey to the same state", async () => {
  const evidence = await runAppDeveloperJourney({
    workspaceRoot: await tempWorkspace(),
  });

  assert.equal(evidence.dev.restart.killed, true);
  assert.deepEqual(evidence.dev.restart.replayedState, evidence.dev.stateBeforeRestart);
  assert.equal(evidence.dev.replayDiff.status, "unchanged");
});

test("anonymous npx hobo up returns an ephemeral zero-account URL", () => {
  const plan = runAnonymousNpxUpScenario();

  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.invocation, {
    executable: "npx",
    package: "hobo",
    args: ["up"],
    priorInstallRequired: false,
  });
  assert.equal(plan.deployment.ownerAccountId, null);
  assert.equal(plan.deployment.ownership, "unowned");
  assert.equal(plan.deployment.camp.inferred, true);
  assert.equal(plan.deployment.camp.envType, "ephemeral");
  assert.equal(plan.deployment.ttl.hours, 24);
  assert.match(plan.url, /^https:\/\/snapshop-[a-z0-9]+\.preview\.hobo\.dev$/);
});

test("blocked deploy gate during up is a clean no-op with an actionable fix", async () => {
  const result = await runBlockedDeployGateScenario();

  assert.equal(result.status, "blocked");
  assert.equal(result.applied, false);
  assert.equal(result.liveUrl, null);
  assert.match(result.fix, /fix|waiver|staging/i);
  assert.equal(result.events.some((event) => event.type === "resource.Provisioned"), false);
  assert.equal(result.events.some((event) => event.type === "deployment.SetApplied"), false);
  assert.equal(result.events.at(-1).type, "deployment.PlanRejected");
});

test("declined-card workflow compensates and leaves no partial state", () => {
  const result = runDeclinedCardScenario();

  assert.equal(result.status, "declined-compensated");
  assert.deepEqual(
    result.events.map((event) => event.type),
    [
      "checkout.InventoryReserved",
      "checkout.PaymentDeclined",
      "checkout.InventoryReleased",
      "checkout.CompensationCompleted",
    ],
  );
  assert.deepEqual(result.finalState, {
    inventoryReserved: false,
    orderCommitted: false,
    compensationFired: true,
  });
});

test("editing resource usage re-infers permissions without stale verbs", () => {
  const readOnly = inferPermissionsForSnapshopSource({ mode: "read-only" });
  const readWrite = inferPermissionsForSnapshopSource({ mode: "read-write" });

  assert.deepEqual(readOnly.permissions, {
    catalog: ["get"],
    images: ["read"],
  });
  assert.deepEqual(readWrite.permissions, {
    catalog: ["get", "set"],
    images: ["read", "write"],
  });
  assert.deepEqual(readWrite.diffFrom(readOnly), {
    catalog: { added: ["set"], removed: [] },
    images: { added: ["write"], removed: [] },
  });
});

test("journey evidence is deterministic across workspaces", async () => {
  const first = await runAppDeveloperJourney({
    workspaceRoot: await tempWorkspace(),
  });
  const second = await runAppDeveloperJourney({
    workspaceRoot: await tempWorkspace(),
  });

  assert.deepEqual(first.deterministicSnapshot, second.deterministicSnapshot);
});
