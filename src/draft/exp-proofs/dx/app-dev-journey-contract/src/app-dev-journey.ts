import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAnonymousPreviewPlan } from "../../../../technical-proofs/anonymous-preview-path-contract/src/anonymous-preview-path.js";
import { writeFixtureProject } from "../../../../technical-proofs/hobo-codegen-cli-contract/src/codegen-cli-contract.js";
import {
  createHoboDevLoop,
  defineDevResource,
} from "../../../../technical-proofs/hobo-dev-loop-contract/src/dev-loop.js";
import { scaffoldHoboProject } from "../../../../technical-proofs/hobo-new-scaffold-contract/src/scaffold.js";
import {
  createHoboUpConvergence,
  sampleSnapshopProject,
} from "../../../../technical-proofs/hobo-up-convergence-contract/src/up-convergence.js";
import { collectBindleResources } from "../../../../technical-proofs/resource-collection-engine-contract/src/resource-collection-engine.js";
import { createRunInspectorProjection } from "../../../../technical-proofs/run-inspector-projection-contract/src/run-inspector.js";
import { isJsonString } from "./json.js";


const FIXED_NOW = "2026-06-28T07:00:00.000Z";
const RUN_ID = "run-snapshop-upload-001";
const CLOUD_PROVIDER_PATTERN =
  /\b(aws|azure|gcp|google cloud|lambda|s3|dynamodb|terraform|pulumi|kubernetes|dockerfile)\b/i;

export async function runAppDeveloperJourney({ workspaceRoot } = {}) {
  if (!isJsonString(workspaceRoot) || workspaceRoot.length === 0) {
    throw new TypeError("workspaceRoot must be a non-empty string");
  }

  const scaffold = await scaffoldHoboProject({
    cwd: workspaceRoot,
    name: "snapshop",
    template: "api",
  });
  await writeFixtureProject(scaffold.projectDir);
  const appSource = snapshopAppSource({ mode: "read-write" });
  await writeFile(join(scaffold.projectDir, "app.ts"), appSource);

  const collection = collectSnapshop({ mode: "read-write" });
  const dev = await runDevJourney(scaffold.projectDir, collection);
  const inspect = inspectLastRun();
  const up = await runCampUp(collection);
  const cloudSpecificCodeMatches = await findCloudSpecificCodeMatches(scaffold.projectDir);

  const deterministicSnapshot = {
    manifestHash: collection.manifestHash,
    permissions: permissionSummary(collection.manifest),
    dev: {
      stateBeforeRestart: dev.stateBeforeRestart,
      replayedState: dev.restart.replayedState,
      replayDiff: dev.replayDiff,
    },
    inspect: {
      status: inspect.status,
      steps: inspect.steps.items.map((step) => ({
        id: step.id,
        status: step.status,
        memoizedDigest: step.memoizedDigest,
      })),
    },
    up: {
      status: up.status,
      liveUrl: up.liveUrl,
      eventTypes: up.events.map((event) => event.type),
    },
    cloudSpecificCodeMatches,
  };

  return {
    commands: {
      new: "hobo new snapshop -t api",
      dev: "hobo dev",
      inspect: "hobo inspect run --last",
      up: "hobo up",
    },
    scaffold: {
      name: scaffold.name,
      template: scaffold.template,
      projectDir: scaffold.projectDir,
      createdFiles: scaffold.createdFiles,
    },
    manifest: collection.manifest,
    manifestHash: collection.manifestHash,
    dev,
    inspect,
    up,
    cloudSpecificCodeMatches,
    deterministicSnapshot,
  };
}

export function runAnonymousNpxUpScenario() {
  return createAnonymousPreviewPlan(
    {
      command: "npx hobo up",
      identity: null,
      camp: null,
      project: {
        name: "snapshop",
        bindleDigest: "sha256:snapshop-app-dev-journey",
      },
      hostedCloud: {
        name: "hobo-hosted",
        previewDomain: "preview.hobo.dev",
        autoApproveInferredCamp: true,
      },
      hostedPolicyGate: {
        status: "approved",
        policyId: "hosted-preview-default",
      },
      abuseGate: {
        status: "approved",
      },
    },
    {
      now: new Date(FIXED_NOW),
      idFactory: (prefix) => `${prefix}-snapshop-001`,
      nonceFactory: () => "snapshoppreview000000000000",
    },
  );
}

export async function runBlockedDeployGateScenario() {
  const collection = collectSnapshop({ mode: "read-write" });
  const engine = createHoboUpConvergence({
    now: () => FIXED_NOW,
    idFactory: deterministicIdFactory(),
    collectResources: (_project, { revision }) => manifestForUp(collection.manifest, revision),
    evaluateGate: () => ({
      status: "failed",
      code: "deploy.gate-blocked",
      reason: "prod deploy requires compatibility waiver",
      fix: "fix the compatibility report or rerun hobo up against staging",
    }),
    applySet: () => {
      throw new Error("blocked gate must not apply resources");
    },
    deployRevision: () => {
      throw new Error("blocked gate must not deploy a live URL");
    },
  });

  return engine.run({
    project: sampleSnapshopProject({
      defaultCampId: "prod",
      currentRevision: "rev-snapshop-read-write",
      resources: resourcesForUp(collection.manifest),
    }),
    flags: { camp: "prod", json: true },
  });
}

export function runDeclinedCardScenario() {
  const state = {
    inventoryReserved: false,
    orderCommitted: false,
    compensationFired: false,
  };
  const events = [];

  reserveInventory(state, events);
  declinePayment(events);
  releaseInventory(state, events);
  events.push(event("checkout.CompensationCompleted", { reason: "card-declined" }));

  return {
    status: "declined-compensated",
    events,
    finalState: state,
  };
}

export function inferPermissionsForSnapshopSource({ mode = "read-write" } = {}) {
  const collection = collectSnapshop({ mode });
  const permissions = permissionSummary(collection.manifest);

  return {
    mode,
    manifestHash: collection.manifestHash,
    manifest: collection.manifest,
    permissions,
    diffFrom(other) {
      return diffPermissions(other.permissions, permissions);
    },
  };
}

async function runDevJourney(projectDir, collection) {
  const devLoop = createHoboDevLoop({ port: 4100, bootMs: 800 });
  const boot = await devLoop.start({
    projectRoot: projectDir,
    resources: devResourcesFor(collection.manifest),
  });
  await devLoop.flushWatch();
  await devLoop.handleRequest({
    path: "/photos/hero",
    body: { photoId: "hero", operation: "upload" },
  });
  const hotReload = await devLoop.reloadHandler({
    path: "app.ts",
    source: 'export const api = { route: "/photos/:id" };',
  });
  await devLoop.handleRequest({
    path: "/photos/hero",
    body: { photoId: "hero", operation: "publish" },
  });
  const stateBeforeRestart = devLoop.currentState();
  await devLoop.stop();

  const restarted = createHoboDevLoop({ port: 4100, bootMs: 800 });
  await restarted.start({
    projectRoot: projectDir,
    resources: devResourcesFor(collection.manifest),
  });
  const replayedState = await restarted.replayPersistedState();
  await restarted.stop();

  const inspector = createRunInspectorProjection(workflowRunEvents());
  const inspected = inspector.inspectRun(RUN_ID);
  const replayDiff = inspector.replayDiff(
    RUN_ID,
    inspected.steps.items.map((step) => ({
      stepId: step.id,
      output: step.output,
      signature: step.signature,
    })),
  );

  return {
    boot,
    hotReload,
    stateBeforeRestart,
    restart: {
      killed: true,
      replayedState,
    },
    replayDiff,
  };
}

function inspectLastRun() {
  return createRunInspectorProjection(workflowRunEvents()).inspectRun(RUN_ID);
}

async function runCampUp(collection) {
  const engine = createHoboUpConvergence({
    now: () => FIXED_NOW,
    idFactory: deterministicIdFactory(),
    collectResources: (_project, { revision }) => manifestForUp(collection.manifest, revision),
  });

  return engine.run({
    project: sampleSnapshopProject({
      defaultCampId: "prod",
      currentRevision: "rev-snapshop-read-write",
      resources: resourcesForUp(collection.manifest),
    }),
    flags: { camp: "prod", json: true },
  });
}

function collectSnapshop({ mode }) {
  return collectBindleResources({
    bindleId: "snapshop",
    fileName: "app.ts",
    sourceText: snapshopAppSource({ mode }),
    define(collect) {
      const catalog = collect.kv("catalog");
      const images = collect.bucket("images");
      const api = collect.api("api", { bind: { catalog, images } });

      catalog.get("photo:hero");
      images.read("hero.jpg");
      if (mode === "read-write") {
        catalog.set("photo:hero", { title: "Hero" });
        images.write("hero.jpg", new Uint8Array([1, 2, 3]));
      }
      api.route("GET", "/photos/:id");
      api.route("POST", "/photos");
    },
  });
}

function snapshopAppSource({ mode }) {
  const writeUsage = mode === "read-write"
    ? `
const photo = { bytes: new Uint8Array([1, 2, 3]) };
catalog.set("photo:hero", { title: "Hero" });
images.write("hero.jpg", photo.bytes);
`
    : "";

  return `import { api, bucket, kv } from "@hobo/bindles";

const catalog = kv("catalog");
const images = bucket("images");
const http = api("api", { bind: { catalog, images } });

catalog.get("photo:hero");
images.read("hero.jpg");
${writeUsage}
http.route("GET", "/photos/:id");
http.route("POST", "/photos");
`;
}

function devResourcesFor(manifest) {
  return Object.entries(manifest.resources).map(([name, resource]) => {
    const kind = resource.kind === "api" ? "api" : resource.kind;
    return defineDevResource(kind, name);
  });
}

function resourcesForUp(manifest) {
  return Object.entries(manifest.resources).map(([id, resource]) => ({
    id,
    type: resource.type === "component.v1" ? "service" : resource.kind,
    deps: (resource.links ?? []).map((link) => link.to).sort(),
  }));
}

function manifestForUp(manifest, revision) {
  return {
    schema: "hobo.manifest/v1",
    revision,
    resources: resourcesForUp(manifest),
  };
}

function permissionSummary(manifest) {
  return Object.fromEntries(
    Object.entries(manifest.resources)
      .filter(([, resource]) => Array.isArray(resource.allow))
      .map(([name, resource]) => [name, [...resource.allow].sort()]),
  );
}

function diffPermissions(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return Object.fromEntries(
    names.map((name) => {
      const previous = new Set(before[name] ?? []);
      const current = new Set(after[name] ?? []);
      return [
        name,
        {
          added: [...current].filter((verb) => !previous.has(verb)).sort(),
          removed: [...previous].filter((verb) => !current.has(verb)).sort(),
        },
      ];
    }),
  );
}

function workflowRunEvents() {
  return [
    runEvent(1, "run.Started", { runId: RUN_ID }),
    runEvent(2, "actor.MessageHandled", {
      runId: RUN_ID,
      actorId: "snapshop-api",
      message: { route: "POST /photos" },
    }),
    runEvent(3, "run.StepStarted", {
      runId: RUN_ID,
      stepId: "resizeImage",
      signature: "resize:v1",
      input: { image: "hero.jpg" },
    }),
    runEvent(4, "run.StepCompleted", {
      runId: RUN_ID,
      stepId: "resizeImage",
      signature: "resize:v1",
      output: { image: "hero-1024.jpg" },
      durationMs: 9,
    }),
    runEvent(5, "run.StepStarted", {
      runId: RUN_ID,
      stepId: "publishCatalogEntry",
      signature: "publish:v1",
      input: { image: "hero-1024.jpg" },
    }),
    runEvent(6, "run.StepCompleted", {
      runId: RUN_ID,
      stepId: "publishCatalogEntry",
      signature: "publish:v1",
      output: { catalogKey: "photo:hero" },
      durationMs: 4,
    }),
    runEvent(7, "run.Completed", { runId: RUN_ID }),
  ];
}

function runEvent(seq, type, data) {
  return {
    id: `event-${seq}`,
    seq,
    type,
    ts: FIXED_NOW,
    correlationId: RUN_ID,
    causationId: seq === 1 ? null : `event-${seq - 1}`,
    data,
  };
}

function reserveInventory(state, events) {
  state.inventoryReserved = true;
  events.push(event("checkout.InventoryReserved", { sku: "print-hero" }));
}

function declinePayment(events) {
  events.push(event("checkout.PaymentDeclined", { code: "card_declined" }));
}

function releaseInventory(state, events) {
  state.inventoryReserved = false;
  state.compensationFired = true;
  events.push(event("checkout.InventoryReleased", { sku: "print-hero" }));
}

function event(type, data) {
  return {
    id: `event:${type}`,
    type,
    data,
  };
}

async function findCloudSpecificCodeMatches(projectDir) {
  const files = ["app.ts", "hobo.bindle.json", "package.json"];
  const matches = [];
  for (const file of files) {
    const text = await readFile(join(projectDir, file), "utf8");
    const match = CLOUD_PROVIDER_PATTERN.exec(text);
    if (match) {
      matches.push({ file, match: match[0] });
    }
  }
  return matches;
}

function deterministicIdFactory() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}
