import assert from "node:assert/strict";
import { test } from "vitest";

import {
  assertClosureBuilderTooling,
  assertNoLegacyClosureBuilderSyntax,
  canonicalClosureBuilderScaffold,
  canonicalClosureBuilderSource,
  typecheckGeneratedAliases,
} from "../src/closure-builder-tooling.ts";

test("closure-builder resources feed coverage, collect, and manifest lowering with generated IDs", () => {
  const result = assertClosureBuilderTooling({
    sourceText: canonicalClosureBuilderSource(),
    observedResourceIds: ["res_0001", "res_0002", "res_0003"],
    fileName: "app.bindle.ts",
  });

  assert.equal(result.coverage.ok, true);
  assert.equal(result.manifest.name, "shop");
  assert.deepEqual(
    result.manifest.resources.map((resource) => ({
      id: resource.generatedId,
      kind: resource.kind,
      alias: resource.alias,
    })),
    [
      { id: "res_0001", kind: "cache", alias: "cache" },
      { id: "res_0002", kind: "api", alias: "api" },
      { id: "res_0003", kind: "queue", alias: "workQueue" },
    ],
  );
  assert.deepEqual(result.manifest.relationships, [
    { from: "res_0002", to: "res_0001", verb: "dependsOn" },
    { from: "res_0003", to: "res_0002", verb: "dependsOn" },
  ]);
});

test("generated aliases type-check without becoming resource IDs", async () => {
  const result = assertClosureBuilderTooling({
    sourceText: canonicalClosureBuilderSource(),
    observedResourceIds: ["res_0001", "res_0002", "res_0003"],
  });

  assert.match(result.codegen.declarations, /readonly cache: ResourceBinding<"res_0001", "cache">/);
  assert.match(result.codegen.declarations, /readonly api: ResourceBinding<"res_0002", "api">/);
  assert.doesNotMatch(result.codegen.declarations, /ResourceBinding<"cache"/);
  await typecheckGeneratedAliases(result.codegen.declarations);
});

test("collection coverage fails closed on unobserved closure-builder resources", () => {
  assert.throws(
    () =>
      assertClosureBuilderTooling({
        sourceText: canonicalClosureBuilderSource(),
        observedResourceIds: ["res_0001", "res_0002"],
        fileName: "app.bindle.ts",
      }),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.match(String(error), /CLOSURE_BUILDER_TOOLING_COVERAGE_GAP/);
      assert.match(String(error), /workQueue/);
      assert.match(String(error), /res_0003/);
      return true;
    },
  );
});

test("declared resources must be returned aliases before tooling accepts them", () => {
  assert.throws(
    () =>
      assertClosureBuilderTooling({
        sourceText: canonicalClosureBuilderSource().replace("return { cache, api, workQueue };", "return { cache, api };"),
      }),
    /CLOSURE_BUILDER_TOOLING_UNRETURNED_RESOURCE/,
  );
});

test("scaffold uses the canonical closure-builder sample and rejects pre-v1 syntax", () => {
  const scaffold = canonicalClosureBuilderScaffold("snapshop");
  const source = scaffold.files["app.bindle.ts"];

  assert.match(source, /import \{ bindle \} from "@hobo\/bindles"/);
  assert.match(source, /const cache = b\.cache\(\);/);
  assert.match(source, /const api = b\.api\(\(\) => myApi\.run\(\)\)\.dependsOn\(cache\);/);
  assert.match(source, /return \{ cache, api, workQueue \};/);
  assert.doesNotMatch(source, /b\.use\(/);
  assert.doesNotMatch(source, /cache\("cache"\)/);
  assert.doesNotThrow(() => assertNoLegacyClosureBuilderSyntax(source));
  assert.deepEqual(scaffold.nextCommands, ["hobo collect --json", "hobo codegen --check"]);
});
