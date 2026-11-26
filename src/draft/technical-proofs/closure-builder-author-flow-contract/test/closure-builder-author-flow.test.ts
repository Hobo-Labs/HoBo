import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CLOSURE_BUILDER_AUTHOR_FLOW_CORPUS_PATH,
  buildClosureBuilderAuthorFlow,
  runClosureBuilderAuthorFlowConformance,
} from "../src/closure-builder-author-flow.ts";

test("closure-builder author flow collects cache, api, and queue into manifest edges", () => {
  const flow = buildClosureBuilderAuthorFlow();

  assert.deepEqual(
    flow.collected.resources.map((resource) => resource.kind),
    ["cache", "queue", "api"],
  );
  assert.deepEqual(flow.lowered.manifest.relationships, [
    { from: "res_api_0001", to: "res_cache_0001", verb: "dependsOn" },
    { from: "res_api_0001", to: "res_queue_0001", verb: "dependsOn" },
  ]);
  assert.deepEqual(flow.lowered.manifest.resources.res_api_0001.links, [
    { to: "res_cache_0001", relationship: "dependsOn" },
    { to: "res_queue_0001", relationship: "dependsOn" },
  ]);
});

test("closure-builder author flow keeps aliases typed and separate from deployment identity", () => {
  const flow = buildClosureBuilderAuthorFlow();

  assert.deepEqual(flow.lowered.manifest.authoringAliases, {
    api: "res_api_0001",
    cache: "res_cache_0001",
    orders: "res_queue_0001",
  });
  assert.deepEqual(flow.identityDiagnostics, [
    {
      alias: "cache",
      generatedId: "res_cache_0001",
      kind: "cache",
      ownerBindleId: "snapshop",
      physicalNameSeed: "snapshop:res_cache_0001",
    },
    {
      alias: "orders",
      generatedId: "res_queue_0001",
      kind: "queue",
      ownerBindleId: "snapshop",
      physicalNameSeed: "snapshop:res_queue_0001",
    },
    {
      alias: "api",
      generatedId: "res_api_0001",
      kind: "api",
      ownerBindleId: "snapshop",
      physicalNameSeed: "snapshop:res_api_0001",
    },
  ]);
  assert.equal(Object.hasOwn(flow.lowered.manifest.resources, "api"), false);
  assert.equal(Object.hasOwn(flow.lowered.manifest.resources, "cache"), false);
});

test("closure-builder author flow reports the v1 corpus as conformance input", () => {
  assert.deepEqual(runClosureBuilderAuthorFlowConformance(), {
    suite: "@hobo/conformance/sdk/closure-builder-author-flow",
    corpusPath: CLOSURE_BUILDER_AUTHOR_FLOW_CORPUS_PATH,
    status: "passed",
    cases: [{ name: "snapshop-cache-api-orders", status: "passed" }],
  });
});
