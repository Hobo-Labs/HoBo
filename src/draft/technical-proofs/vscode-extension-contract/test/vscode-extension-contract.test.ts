import assert from "node:assert/strict";
import { test } from "vitest";

import { createSamplePlanFixture } from "../../hobo-plan-preview-contract/src/plan-preview.js";
import { fixtureEvents } from "../../hobo-inspect-projection-contract/src/inspect-contract.js";
import {
  assertSharedExtensionHandlers,
  createVsCodeExtensionAdapter,
  largeTopologyEvents,
  sampleRunEvents,
} from "../src/vscode-extension-contract.js";

test("opening a HoBo project renders TopologyView through the shared inspect/read surface", async () => {
  const extension = createVsCodeExtensionAdapter({
    events: fixtureEvents(),
    planFixture: createSamplePlanFixture(),
  });

  const workspace = await extension.openWorkspace();

  assert.equal(workspace.status, "ready");
  assert.equal(workspace.topology.sourceProjection, "TopologyView");
  assert.deepEqual(
    workspace.topology.visibleNodes.map((node) => [node.id, node.provider, node.region]),
    [
      ["api", "aws", "us-east-1"],
      ["db", "neon", "us-east-1"],
    ],
  );
  assert.deepEqual(workspace.topology.visibleEdges, [
    { from: "api", to: "db", capability: "postgres", tier: "private-link" },
  ]);
  assert.deepEqual(workspace.handlerTrace.topology, {
    command: "hobo.vscode.openTopology",
    cliVerb: "inspect",
    cliArgs: ["topology", "--json"],
    mcpTool: "get_bindle",
  });
});

test("selecting a run shows the RunView step trace, timeline, actors, and sagas", async () => {
  const extension = createVsCodeExtensionAdapter({
    events: sampleRunEvents(),
    planFixture: createSamplePlanFixture(),
  });

  const run = await extension.selectRun("run-264");

  assert.equal(run.status, "ready");
  assert.equal(run.run.sourceProjection, "RunView");
  assert.equal(run.run.id, "run-264");
  assert.equal(run.run.partial, false);
  assert.deepEqual(
    run.run.steps.map((step) => [step.id, step.status, step.attempts, step.durationMs]),
    [
      ["plan", "completed", 1, 12],
      ["apply", "completed", 2, 55],
    ],
  );
  assert.equal(run.run.timeline.length, 11);
  assert.equal(run.run.actors[0].id, "resource:api");
  assert.equal(run.run.sagas[0].id, "deploy-saga");
  assert.deepEqual(run.handlerTrace, {
    command: "hobo.vscode.openRunInspector",
    cliVerb: "inspect",
    cliArgs: ["run", "run-264", "--json"],
    mcpTool: "inspect_run",
  });
});

test("explain this plan annotates the hobo plan diff using the same plan handler", async () => {
  const extension = createVsCodeExtensionAdapter({
    events: fixtureEvents(),
    planFixture: createSamplePlanFixture(),
  });

  const explanation = await extension.explainThisPlan({ camp: "prod" });

  assert.equal(explanation.status, "ready");
  assert.equal(explanation.plan.status, "would-change");
  assert.deepEqual(explanation.plan.sideEffectEvents, []);
  assert.match(explanation.inlineAnnotations[0].message, /catalog -> azure\.tableStorage/);
  assert.ok(
    explanation.inlineAnnotations.some((annotation) =>
      annotation.message.includes("cross-cloud edge api -> images uses public-mtls"),
    ),
  );
  assert.deepEqual(explanation.handlerTrace, {
    command: "hobo.vscode.explainThisPlan",
    cliVerb: "plan",
    cliArgs: ["--camp", "prod", "--json"],
    mcpTool: "plan",
  });
});

test("provider-option autocomplete is sourced from shipped provider types", () => {
  const extension = createVsCodeExtensionAdapter();

  const completions = extension.completeProviderOptions({
    sourceText: "bucket.with(aws.",
    cursor: "bucket.with(aws.".length,
  });

  assert.equal(completions.status, "ready");
  assert.deepEqual(
    completions.items.map((item) => [item.label, item.detail]),
    [
      ["s3", "aws.s3: object-storage options"],
      ["dynamoDb", "aws.dynamoDb: key-value options"],
      ["containerApp", "aws.containerApp: http-service options"],
    ],
  );
  assert.equal(completions.source, "@hobo/aws/provider-options.d.ts");
});

test("missing local dev or Camp reachability shows an actionable prompt instead of error spew", async () => {
  const extension = createVsCodeExtensionAdapter({
    devReachable: false,
    campReachable: false,
  });

  const workspace = await extension.openWorkspace();
  const explanation = await extension.explainThisPlan({ camp: "prod" });

  assert.equal(workspace.status, "needs-dev");
  assert.equal(workspace.prompt.action.command, "hobo.dev");
  assert.match(workspace.prompt.message, /Start hobo dev/);
  assert.doesNotMatch(workspace.prompt.message, /Error|stack|ECONNREFUSED/i);
  assert.equal(explanation.status, "needs-dev");
  assert.equal(explanation.prompt.action.command, "hobo.dev");
});

test("large topology uses a windowed graph model so editor rendering stays bounded", async () => {
  const extension = createVsCodeExtensionAdapter({
    events: largeTopologyEvents(1500),
    viewportSize: 75,
  });

  const workspace = await extension.openWorkspace();

  assert.equal(workspace.status, "ready");
  assert.equal(workspace.topology.virtualized, true);
  assert.equal(workspace.topology.nodeCount, 1500);
  assert.equal(workspace.topology.visibleNodes.length, 75);
  assert.equal(workspace.topology.visibleEdges.length, 74);
});

test("extension never embeds credentials and reuses the CLI SVID store", () => {
  const extension = createVsCodeExtensionAdapter();

  assert.deepEqual(extension.credentialUse(), {
    mode: "cli-svid-store-ref",
    svidStoreRef: "hobo-cli://svid-store/current",
    embeddedCredentials: [],
  });
  assert.throws(
    () =>
      createVsCodeExtensionAdapter({
        extensionManifest: {
          contributes: {},
          secrets: { accessKey: "AKIAEXAMPLE", token: "static-token" },
        },
      }),
    /embedded credential/i,
  );
});

test("out-of-date extension and CLI surfaces warn instead of rendering stale data", async () => {
  const extension = createVsCodeExtensionAdapter({
    extensionSurfaceVersion: "hobo.extension-surface/v1",
    cliSurfaceVersion: "hobo.extension-surface/v2",
  });

  const workspace = await extension.openWorkspace();

  assert.equal(workspace.status, "surface-warning");
  assert.equal(workspace.topology, null);
  assert.deepEqual(workspace.warnings, [
    {
      code: "HOBO_EXTENSION_SURFACE_MISMATCH",
      message: "VS Code extension surface hobo.extension-surface/v1 is behind CLI surface hobo.extension-surface/v2.",
      action: "Upgrade the HoBo VS Code extension or align the hobo CLI version.",
    },
  ]);
});

test("declared VS Code commands stay bound to existing CLI verbs and MCP tools", () => {
  const parity = assertSharedExtensionHandlers();

  assert.equal(parity.ok, true);
  assert.deepEqual(parity.commands, [
    "hobo.vscode.openTopology",
    "hobo.vscode.openRunInspector",
    "hobo.vscode.explainThisPlan",
  ]);
});
