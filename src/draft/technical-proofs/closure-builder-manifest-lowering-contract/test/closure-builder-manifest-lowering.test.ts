import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CLOSURE_BUILDER_LOWERING_CORPUS,
  ClosureBuilderLoweringError,
  canonicalJson,
  lowerClosureBuilderGraph,
  runClosureBuilderLoweringConformance,
} from "../src/closure-builder-manifest-lowering.ts";

test("golden closure-builder corpus lowers to hobo:sdk calls and hobo.manifest/v1 IR", () => {
  const [fixture] = CLOSURE_BUILDER_LOWERING_CORPUS;
  const result = lowerClosureBuilderGraph(fixture.input);

  assert.deepEqual(result.witCalls, fixture.expectedWitCalls);
  assert.deepEqual(result.manifest, fixture.expectedManifest);
  assert.equal(result.manifestJson, canonicalJson(fixture.expectedManifest));
  assert.equal(
    result.manifestHash,
    "sha256:dafdd61811b290a90dc55739644a65387bebb2d757ddb73207798c06c8bffb8b",
  );
  assert.equal(result.manifest.schema, "hobo.manifest/v1");
});

test("generated IDs remain deployment identity while aliases stay authoring-only", () => {
  const [fixture] = CLOSURE_BUILDER_LOWERING_CORPUS;
  const renamed = {
    ...fixture.input,
    aliases: [
      { alias: "renamedCache", generatedId: "res_0001" },
      { alias: "renamedApi", generatedId: "res_0002" },
      { alias: "renamedQueue", generatedId: "res_0003" },
    ],
  };

  const original = lowerClosureBuilderGraph(fixture.input);
  const changedAliases = lowerClosureBuilderGraph(renamed);

  assert.deepEqual(Object.keys(original.manifest.resources), [
    "res_0001",
    "res_0002",
    "res_0003",
  ]);
  assert.deepEqual(
    changedAliases.manifest.resources,
    original.manifest.resources,
  );
  assert.notDeepEqual(
    changedAliases.manifest.authoringAliases,
    original.manifest.authoringAliases,
  );
});

test("duplicate authoring aliases are refused instead of overwriting deployment identity", () => {
  const [fixture] = CLOSURE_BUILDER_LOWERING_CORPUS;

  assert.throws(
    () =>
      lowerClosureBuilderGraph({
        ...fixture.input,
        aliases: [
          { alias: "cache", generatedId: "res_0001" },
          { alias: "cache", generatedId: "res_0002" },
        ],
      }),
    (error) =>
      error instanceof ClosureBuilderLoweringError &&
      error.code === "CLOSURE_LOWERING_DUPLICATE_ALIAS",
  );
});

test("planner-compatible relation facets are explicit and independent from returned aliases", () => {
  const [fixture] = CLOSURE_BUILDER_LOWERING_CORPUS;
  const result = lowerClosureBuilderGraph(fixture.input);

  assert.deepEqual(result.manifest.relationships, [
    { from: "res_0002", to: "res_0001", verb: "dependsOn" },
    { from: "res_0002", to: "res_0003", verb: "dependsOn" },
  ]);
  assert.deepEqual(result.manifest.resources.res_0002.links, [
    { to: "res_0001", relationship: "dependsOn" },
    { to: "res_0003", relationship: "dependsOn" },
  ]);
});

test("provider .with annotations stay inert manifest annotations without provider resolution", () => {
  const [fixture] = CLOSURE_BUILDER_LOWERING_CORPUS;
  const result = lowerClosureBuilderGraph(fixture.input);

  assert.deepEqual(result.manifest.resources.res_0002.providerOptions, [
    { provider: "aws", option: "fargate", value: { cpu: 512 } },
  ]);
  assert.equal("provider" in result.manifest.resources.res_0002, false);
  assert.equal("resolvedProvider" in result.manifest.resources.res_0002, false);
  assert.equal(
    result.witCalls.some((call) => call.function === "resolve-provider"),
    false,
  );
});

test("runtime workload factories stay inert during lowering", () => {
  let started = false;
  const [fixture] = CLOSURE_BUILDER_LOWERING_CORPUS;
  const input = {
    ...fixture.input,
    resources: [...fixture.input.resources],
  };
  input.resources[1] = {
    ...input.resources[1],
    workload: {
      kind: "inert-workload-factory",
      entrypoint: "myApi.run",
      factory: () => {
        started = true;
      },
    } as never,
  };

  const result = lowerClosureBuilderGraph(input);

  assert.equal(started, false);
  assert.deepEqual(result.manifest.resources.res_0002.workload, {
    kind: "inert-workload-factory",
    entrypoint: "myApi.run",
  });
});

test("same-kind insertion identity ledger requirements fail closed for HOBO-538", () => {
  assert.throws(
    () =>
      lowerClosureBuilderGraph({
        bindleName: "shop",
        resources: [
          { generatedId: "res_0001", kind: "cache" },
          { generatedId: "res_0002", kind: "cache" },
        ],
        aliases: [
          { alias: "cache", generatedId: "res_0001" },
          { alias: "otherCache", generatedId: "res_0002" },
        ],
        relationships: [],
        requiresSameKindIdentityLedger: true,
      }),
    (error) =>
      error instanceof ClosureBuilderLoweringError &&
      error.code === "CLOSURE_LOWERING_IDENTITY_LEDGER_REQUIRED",
  );
});

test("conformance report consumes the closure-builder lowering corpus", () => {
  assert.deepEqual(
    runClosureBuilderLoweringConformance(CLOSURE_BUILDER_LOWERING_CORPUS),
    {
      suite: "@hobo/conformance/sdk/closure-builder-lowering",
      corpusPath:
        "src/draft/technical-proofs/closure-builder-manifest-lowering-contract/src/closure-builder-manifest-lowering.ts#CLOSURE_BUILDER_LOWERING_CORPUS",
      status: "passed",
      cases: [{ name: "shop-cache-api-queue", status: "passed" }],
    },
  );
});
