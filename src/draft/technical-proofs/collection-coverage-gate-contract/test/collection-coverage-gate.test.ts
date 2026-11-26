import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  CollectionCoverageError,
  assertCanDeployCollectionCoverage,
  evaluateCollectionCoverage,
} from "../src/collection-coverage-gate.js";

const branchySource = `
import { data } from "@hobo/bindles";

export function defineResources(usePostgres) {
  if (usePostgres) {
    data("todos-db");
  } else {
    data("todos-cache");
  }
}
`;

describe("collection coverage gate contract", () => {
  it("fails can-deploy when static analysis finds an unobserved branch resource", () => {
    assert.throws(
      () =>
        assertCanDeployCollectionCoverage({
          sourceText: branchySource,
          observedResourceIds: ["todos-db"],
          fileName: "bindle.ts",
        }),
      (error) => {
        assert.ok(error instanceof CollectionCoverageError);
        assert.match(error.message, /todos-cache/);
        assert.match(error.message, /else usePostgres/);
        assert.deepEqual(error.diagnostics[0], {
          code: "collection.coverage.unobserved-resource",
          severity: "error",
          resourceId: "todos-cache",
          branch: "else usePostgres",
          fileName: "bindle.ts",
          line: 8,
          message:
            "Resource todos-cache is statically declared on else usePostgres but was not observed by collection.",
        });
        return true;
      },
    );
  });

  it("passes when collection observed every statically declared resource", () => {
    const result = assertCanDeployCollectionCoverage({
      sourceText: branchySource,
      observedResourceIds: ["todos-db", "todos-cache"],
      fileName: "bindle.ts",
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "pass");
    assert.deepEqual(result.unobservedDeclarations, []);
  });

  it("returns a machine-readable coverage result for agents and can-deploy", () => {
    const result = evaluateCollectionCoverage({
      sourceText: branchySource,
      observedResourceIds: ["todos-db"],
      fileName: "bindle.ts",
    });

    assert.equal(result.ok, false);
    assert.equal(result.canDeployDimension, "collectionCoverage");
    assert.equal(result.status, "fail");
    assert.deepEqual(result.observedResourceIds, ["todos-db"]);
    assert.deepEqual(
      result.declaredResources.map(({ resourceId, branch, line }) => ({
        resourceId,
        branch,
        line,
      })),
      [
        { resourceId: "todos-db", branch: "if usePostgres", line: 6 },
        { resourceId: "todos-cache", branch: "else usePostgres", line: 8 },
      ],
    );
    assert.deepEqual(result.unobservedDeclarations.map((item) => item.resourceId), [
      "todos-cache",
    ]);
    assert.deepEqual(result.unresolvedDeclarations, []);
  });

  it("reports unreachable declarations distinctly from unobserved reachable branches", () => {
    const result = evaluateCollectionCoverage({
      sourceText: `
        import { data } from "@hobo/bindles";
        if (false) {
          data("legacy-db");
        }
      `,
      observedResourceIds: [],
      fileName: "dead.ts",
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "pass-with-warnings");
    assert.deepEqual(result.unobservedDeclarations, []);
    assert.equal(result.unreachableDeclarations[0].resourceId, "legacy-db");
    assert.equal(
      result.diagnostics[0].code,
      "collection.coverage.unreachable-resource",
    );
  });

  it("fails closed when a dynamic resource name cannot be proven statically", () => {
    const result = evaluateCollectionCoverage({
      sourceText: `
        import { data } from "@hobo/bindles";
        const name = process.env.RESOURCE_NAME;
        data(name);
      `,
      observedResourceIds: [],
      fileName: "dynamic.ts",
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "fail");
    assert.deepEqual(result.declaredResources, []);
    assert.equal(result.unresolvedDeclarations[0].callee, "data");
    assert.equal(
      result.diagnostics[0].code,
      "collection.coverage.cannot-prove-resource-name",
    );
    assert.match(result.diagnostics[0].message, /cannot prove/);
  });

  it("recognizes canonical bindles factories and nested b.use declarations", () => {
    const sourceText = `
      import { bindle, database, kv, service, web } from "@hobo/bindles";

      export default bindle("shop", (b) => {
        const db = b.use(database("db", { engine: "postgres" }));
        const cache = b.use(kv("cache"));
        const api = b.use(service("api", {
          handler: "./src/api",
          bind: { db, cache },
        }));

        b.use(web("site", { handler: "./src/site", bind: { api } }));
      });
    `;

    const failing = evaluateCollectionCoverage({
      sourceText,
      observedResourceIds: ["db", "api", "site"],
      observedBindKeys: ["api->db", "site->api"],
      fileName: "bindle.ts",
    });

    assert.equal(failing.ok, false);
    assert.deepEqual(
      failing.declaredResources.map((resource) => resource.resourceId),
      ["db", "cache", "api", "site"],
    );
    assert.deepEqual(
      failing.declaredBinds.map((bind) => bind.key),
      ["api->db", "api->cache", "site->api"],
    );
    assert.deepEqual(failing.unobservedDeclarations.map((item) => item.resourceId), [
      "cache",
    ]);
    assert.deepEqual(failing.unobservedBinds.map((item) => item.key), [
      "api->cache",
    ]);

    const passing = evaluateCollectionCoverage({
      sourceText,
      observedResourceIds: ["db", "cache", "api", "site"],
      observedBindKeys: ["api->db", "api->cache", "site->api"],
      fileName: "bindle.ts",
    });

    assert.equal(passing.ok, true);
  });

  it("uses @hobo/bindles import provenance for aliases and namespaces", () => {
    const result = evaluateCollectionCoverage({
      sourceText: `
        import { database as dbResource } from "@hobo/bindles";
        import * as bindles from "@hobo/bindles";

        function database() {}
        function data() {}

        database("local-db");
        data("local-data");
        dbResource("from-alias");
        bindles.kv("from-namespace");
      `,
      observedResourceIds: ["from-alias"],
      fileName: "imports.ts",
    });

    assert.deepEqual(
      result.declaredResources.map((resource) => resource.resourceId),
      ["from-alias", "from-namespace"],
    );
    assert.deepEqual(result.unobservedDeclarations.map((item) => item.resourceId), [
      "from-namespace",
    ]);
  });

  it("keeps one-line else branch resources reachable", () => {
    const result = evaluateCollectionCoverage({
      sourceText: `
        import { database } from "@hobo/bindles";
        if (false) { database("dead"); } else { database("live"); }
      `,
      observedResourceIds: [],
      fileName: "inline.ts",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.unreachableDeclarations.map((item) => item.resourceId), [
      "dead",
    ]);
    assert.deepEqual(result.unobservedDeclarations.map((item) => item.resourceId), [
      "live",
    ]);
  });

  it("keeps bind declarations in the same machine-readable coverage result", () => {
    const result = evaluateCollectionCoverage({
      sourceText: `
        import { bind, data, service } from "@hobo/bindles";
        const db = data("todos-db");
        const api = service("api");
        bind("api", "todos-db");
      `,
      observedResourceIds: ["todos-db", "api"],
      observedBindKeys: [],
      fileName: "wiring.ts",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.declaredBinds, [
      {
        from: "api",
        to: "todos-db",
        key: "api->todos-db",
        fileName: "wiring.ts",
        line: 5,
        branch: "top-level",
        reachable: true,
        evidence: "wiring.ts:5",
      },
    ]);
    assert.equal(
      result.diagnostics[0].code,
      "collection.coverage.unobserved-bind",
    );

    const passing = evaluateCollectionCoverage({
      sourceText: `
        import { bind, data, service } from "@hobo/bindles";
        data("todos-db");
        service("api");
        bind("api", "todos-db");
      `,
      observedResourceIds: ["todos-db", "api"],
      observedBindKeys: ["api->todos-db"],
      fileName: "wiring.ts",
    });

    assert.equal(passing.ok, true);
  });
});
