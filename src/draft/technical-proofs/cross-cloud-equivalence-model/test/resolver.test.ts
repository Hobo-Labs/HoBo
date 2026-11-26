import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  makeProviderEntry,
  resolveCapability,
  satisfies,
  verdicts,
} from "../src/resolver.js";

const catalog = [
  makeProviderEntry({
    provider: "aws",
    resourceClass: "rds-postgres",
    port: "database",
    paradigm: "relational",
    engines: ["postgres"],
    native: ["managed", "ha"],
  }),
  makeProviderEntry({
    provider: "azure",
    resourceClass: "flexible-server-postgres",
    port: "database",
    paradigm: "relational",
    engines: ["postgres"],
    native: ["managed"],
    remediation:
      "Use aws:rds-postgres for native HA; install a pgvector-capable provider for vector.",
  }),
  makeProviderEntry({
    provider: "cloudflare",
    resourceClass: "r2-object-store",
    port: "objectStore",
    paradigm: "blob",
    native: ["s3-compatible"],
  }),
  makeProviderEntry({
    provider: "fly",
    resourceClass: "machines",
    port: "compute",
    paradigm: "container",
    native: ["container"],
  }),
];

describe("cross-cloud equivalence resolver", () => {
  it("resolves three agnostic ports across multiple providers", () => {
    const database = resolveCapability({
      catalog,
      request: {
        port: "database",
        paradigm: "relational",
        engine: "postgres",
        require: ["managed"],
        prefer: ["ha"],
      },
    });

    const objectStore = resolveCapability({
      catalog,
      request: {
        port: "objectStore",
        paradigm: "blob",
        require: ["s3-compatible"],
      },
    });

    const compute = resolveCapability({
      catalog,
      request: {
        port: "compute",
        paradigm: "container",
        require: ["container"],
      },
    });

    assert.equal(database.verdict, verdicts.FULL);
    assert.equal(database.provider, "aws");
    assert.equal(objectStore.provider, "cloudflare");
    assert.equal(compute.provider, "fly");
  });

  it("returns full, partial, and none from the same request shape", () => {
    const request = {
      port: "database",
      paradigm: "relational",
      engine: "postgres",
      require: ["managed"],
      prefer: ["ha"],
    };

    assert.equal(satisfies(request, catalog[0]).verdict, verdicts.FULL);
    assert.equal(satisfies(request, catalog[1]).verdict, verdicts.PARTIAL);
    assert.equal(satisfies(request, catalog[2]).verdict, verdicts.NONE);
  });

  it("accepts a prefer-only degradation with an actionable PlanWarning", () => {
    const result = resolveCapability({
      catalog: [catalog[1]],
      request: {
        port: "database",
        paradigm: "relational",
        engine: "postgres",
        require: ["managed"],
        prefer: ["ha"],
      },
    });

    assert.equal(result.verdict, verdicts.WARN);
    assert.deepEqual(result.warning.missing, ["ha"]);
    assert.match(result.warning.remediation, /Use aws:rds-postgres/);
  });

  it("rejects a hard requirement when every matching candidate is partial", () => {
    const request = {
      port: "database",
      paradigm: "relational",
      engine: "postgres",
      require: ["managed", "vector"],
    };

    assert.deepEqual(
      catalog.slice(0, 2).map((entry) => satisfies(request, entry).verdict),
      [verdicts.PARTIAL, verdicts.PARTIAL],
    );

    const result = resolveCapability({
      catalog,
      request,
    });

    assert.equal(result.verdict, verdicts.REJECTED);
    assert.equal(result.reason, "no-equivalent-provider");
    assert.ok(result.rejected.some((candidate) => candidate.missing.includes("vector")));
    assert.ok(
      result.rejected.some((candidate) => candidate.remediation?.includes("pgvector-capable")),
    );
  });

  it("accepts third-party extension entries without changing a central enum", () => {
    const extensionCatalog = [
      ...catalog,
      makeProviderEntry({
        provider: "neon",
        resourceClass: "serverless-postgres",
        port: "database",
        paradigm: "relational",
        engines: ["postgres"],
        native: ["managed", "serverless"],
      }),
    ];

    const result = resolveCapability({
      catalog: extensionCatalog,
      request: {
        port: "database",
        paradigm: "relational",
        engine: "postgres",
        require: ["managed", "serverless"],
      },
    });

    assert.equal(result.verdict, verdicts.FULL);
    assert.equal(result.provider, "neon");
    assert.equal(result.resourceClass, "serverless-postgres");
  });

  it("treats lying equivalence entries as unavailable until conformance passes", () => {
    const result = resolveCapability({
      catalog: [
        makeProviderEntry({
          provider: "fakecloud",
          resourceClass: "claimed-postgres",
          port: "database",
          paradigm: "relational",
          engines: ["postgres"],
          native: ["managed"],
          conformance: "failed",
        }),
      ],
      request: {
        port: "database",
        paradigm: "relational",
        engine: "postgres",
        require: ["managed"],
      },
    });

    assert.equal(result.verdict, verdicts.REJECTED);
    assert.equal(result.rejected[0].reason, "conformance-not-passed");
  });

  it("does not treat cross-paradigm resources as equivalent", () => {
    const result = resolveCapability({
      catalog: [
        makeProviderEntry({
          provider: "documentdb",
          resourceClass: "mongo-cluster",
          port: "database",
          paradigm: "document",
          engines: ["mongo"],
          native: ["managed"],
        }),
      ],
      request: {
        port: "database",
        paradigm: "relational",
        engine: "postgres",
        require: ["managed"],
      },
    });

    assert.equal(result.verdict, verdicts.REJECTED);
    assert.equal(result.rejected[0].reason, "paradigm-mismatch");
  });
});
