import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertClosureBuilderDocument,
  assertNoLegacyExplicitBindleSyntax,
  closureBuilderContract,
  parseClosureBuilderContract,
  renderCodingAgentChecklist,
} from "../src/closure-builder-public-api.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

test("closure-builder public API pins Bindle as manifest assembly, not app host behavior", () => {
  const contract = closureBuilderContract();

  assert.equal(contract.packageName, "@hobo/bindles");
  assert.equal(contract.bindleRole, "manifest-assembly");
  assert.equal(contract.appHostOwner, "imported-app-code");
  assert.equal(contract.runtimeHostBehavior, "out-of-scope");
  assert.deepEqual(contract.relationshipVerbs, ["dependsOn"]);
  assert.equal(contract.builderFactories.every((factory) => factory.acceptsResourceName === false), true);

  assert.doesNotThrow(() => assertClosureBuilderDocument(contract));
});

test("legacy explicit-bindle vocabulary fails while canonical closure builder passes", () => {
  const legacy = `
    import { bindle, database, service } from "@hobo/bindles";
    export default bindle("shop", b => {
      const db = b.use(database("db", { engine: "postgres" }));
      const api = b.use(service("api", { bind: { db } }));
      return { db, api };
    });
  `;

  assert.throws(() => assertNoLegacyExplicitBindleSyntax(legacy), /CLOSURE_BUILDER_LEGACY_EXPLICIT_BINDLE/);

  const canonical = `
    import { bindle } from "@hobo/bindles";
    import myApi from "@myproject/services";
    export default bindle("shop", b => {
      const cache = b.cache();
      const api = b.api(() => myApi.run()).dependsOn(cache);
      return { cache, api };
    });
  `;

  assert.doesNotThrow(() => assertNoLegacyExplicitBindleSyntax(canonical));
});

test("parser rejects signature drift, alternate relationship verbs, app-host ownership, and package drift", () => {
  assert.throws(
    () =>
      parseClosureBuilderContract({
        packageName: "@hobo/sdk",
        bindleRole: "app-host",
        appHostOwner: "bindle-builder",
        runtimeHostBehavior: "implemented",
        relationshipVerbs: ["dependsOn", "bind"],
        builderFactories: [{ name: "cache", acceptsResourceName: false }],
      }),
    /CLOSURE_BUILDER_PACKAGE_OWNERSHIP/,
  );

  assert.throws(
    () =>
      parseClosureBuilderContract({
        packageName: "@hobo/bindles",
        bindleSignature: "bindle(name)",
        bindleRole: "manifest-assembly",
        appHostOwner: "imported-app-code",
        runtimeHostBehavior: "out-of-scope",
        relationshipVerbs: ["dependsOn"],
        builderFactories: [{ name: "cache", acceptsResourceName: false }],
      }),
    /CLOSURE_BUILDER_SIGNATURE/,
  );

  assert.throws(
    () =>
      parseClosureBuilderContract({
        packageName: "@hobo/bindles",
        bindleSignature: "bindle(name, builderFn)",
        bindleRole: "manifest-assembly",
        appHostOwner: "imported-app-code",
        runtimeHostBehavior: "out-of-scope",
        relationshipVerbs: ["dependsOn", "requires"],
        builderFactories: [{ name: "cache", acceptsResourceName: false }],
      }),
    /CLOSURE_BUILDER_RELATIONSHIP_VERB/,
  );
});

test("coding-agent checklist is vocabulary-complete for downstream HOBO-533 through HOBO-537 work", () => {
  const checklist = renderCodingAgentChecklist(closureBuilderContract());

  assert.match(checklist, /bindle\(name, builderFn\)/);
  assert.match(checklist, /b\.cache\(\)/);
  assert.match(checklist, /b\.api\(\(\) => importedApp\.run\(\)\)/);
  assert.match(checklist, /dependsOn\(\)/);
  assert.doesNotMatch(checklist, /b\.use\(/);
  assert.doesNotMatch(checklist, /database\("db"/);
});

test("v1 public Bindle docs do not keep legacy explicit-resource examples", () => {
  const publicDocs = [
    "docs/design/closure-builder-public-api.md",
    "docs/design/sdk-contracts.md",
    "docs/design/sdk-api.md",
    "docs/design/worked-example.md",
    "docs/design/developer-experience.md",
  ];

  for (const docPath of publicDocs) {
    const content = readFileSync(resolve(repoRoot, docPath), "utf8");
    const bindleExamples = [...content.matchAll(/```ts\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .filter((example) => example.includes("bindle("));

    assert.ok(bindleExamples.length > 0, `${docPath} must include a TypeScript Bindle example`);
    for (const example of bindleExamples) {
      assertNoLegacyExplicitBindleSyntax(example);
    }
  }
});
