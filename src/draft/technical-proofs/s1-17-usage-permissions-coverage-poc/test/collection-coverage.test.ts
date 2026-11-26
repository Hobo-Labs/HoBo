import { describe, expect, it } from "vitest";

import {
  CollectionCoverageError,
  assertCanDeployCollectionCoverage,
  evaluateCollectionCoverage,
} from "../src/collection-coverage.js";

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

describe("collection coverage gate", () => {
  it("fails with collection.coverage.unobserved-resource on unobserved else branch", () => {
    expect(() =>
      assertCanDeployCollectionCoverage({
        sourceText: branchySource,
        observedResourceIds: ["todos-db"],
        fileName: "bindle.ts",
      }),
    ).toThrowError(CollectionCoverageError);

    const result = evaluateCollectionCoverage({
      sourceText: branchySource,
      observedResourceIds: ["todos-db"],
      fileName: "bindle.ts",
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toEqual({
      code: "collection.coverage.unobserved-resource",
      severity: "error",
      resourceId: "todos-cache",
      branch: "else usePostgres",
      fileName: "bindle.ts",
      line: 8,
      message:
        "Resource todos-cache is statically declared on else usePostgres but was not observed by collection.",
    });
    expect(result.eventLog.events[0]?.type).toBe("coverage.Failed");
  });

  it("fails with collection.coverage.cannot-prove-resource-name for computed names", () => {
    const sourceText = `
      import { bucket } from "@hobo/bindles";
      const region = "us";
      bucket(\`logs-\${region}\`);
    `;

    expect(() =>
      assertCanDeployCollectionCoverage({
        sourceText,
        observedResourceIds: [],
        fileName: "dynamic.ts",
      }),
    ).toThrowError(CollectionCoverageError);

    const result = evaluateCollectionCoverage({
      sourceText,
      observedResourceIds: [],
      fileName: "dynamic.ts",
    });

    expect(result.diagnostics[0]?.code).toBe("collection.coverage.cannot-prove-resource-name");
  });

  it("passes when collection observed every statically declared resource", () => {
    const result = assertCanDeployCollectionCoverage({
      sourceText: branchySource,
      observedResourceIds: ["todos-db", "todos-cache"],
      fileName: "bindle.ts",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("pass");
    expect(result.eventLog.events[0]?.type).toBe("coverage.Evaluated");
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

    expect(result.ok).toBe(true);
    expect(result.status).toBe("pass-with-warnings");
    expect(result.unobservedDeclarations).toEqual([]);
    expect(result.unreachableDeclarations[0]?.resourceId).toBe("legacy-db");
    expect(result.diagnostics[0]?.code).toBe("collection.coverage.unreachable-resource");
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

    expect(result.declaredResources.map((r) => r.resourceId)).toEqual([
      "from-alias",
      "from-namespace",
    ]);
    expect(result.unobservedDeclarations.map((item) => item.resourceId)).toEqual(["from-namespace"]);
  });
});
