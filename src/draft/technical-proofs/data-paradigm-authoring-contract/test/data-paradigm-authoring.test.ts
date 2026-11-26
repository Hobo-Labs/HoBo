import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "vitest";

import * as authoring from "../src/data-paradigm-authoring.js";
import {
  AuthoringSurfaceError,
  createManifest,
  data,
  importParadigmPackage,
} from "../src/data-paradigm-authoring.js";

const hoboSql = importParadigmPackage({
  packageName: "@hobo/sql",
  paradigm: "relational",
  equivalenceClass: "managed-postgres",
  port: "hobo:data",
  features: [
    {
      name: "table",
      crossParadigmEquivalent: true,
    },
  ],
});

const hoboDocument = importParadigmPackage({
  packageName: "@hobo/document",
  paradigm: "document",
  equivalenceClass: "managed-document",
  port: "hobo:data",
});

const hoboVector = importParadigmPackage({
  packageName: "@hobo/vector",
  paradigm: "vector",
  equivalenceClass: "search-extension",
  port: "hobo:data",
  extensionPort: "hobo:search",
  features: [
    {
      name: "ann-index",
      crossParadigmEquivalent: false,
    },
  ],
});

const hoboGraph = importParadigmPackage({
  packageName: "@hobo/graph",
  paradigm: "graph",
  equivalenceClass: "search-extension",
  port: "hobo:data",
  extensionPort: "hobo:search",
  features: [
    {
      name: "traversal",
      crossParadigmEquivalent: false,
    },
  ],
});

const awsRdsNativePin = Object.freeze({
  __kind: "hobo.provider-option",
  provider: "aws",
  optionName: "rds",
  annotationKey: "aws.rds",
  resourceKinds: ["data"],
  value: {
    engine: "postgres",
    instanceClass: "db.r7g.large",
  },
});

describe("data paradigm package authoring contract", () => {
  it("opts @hobo/sql onto data() as hobo:data with surfaced specialization markers", () => {
    const db = data("db").use(hoboSql);
    const lowering = db.query({ text: "select * from todos" });
    const manifest = createManifest([db]);

    assert.deepEqual(lowering.portRef, ["hobo:data"]);
    assert.deepEqual(lowering.extensionPortRef, []);
    assert.deepEqual(manifest.resources.db, {
      type: "data.v1",
      port: "hobo:data",
      kind: "data",
      allow: ["query"],
      usage: {
        inferred: ["query"],
        source: "run-to-collect",
      },
      collection: {
        stableId: "data:db",
      },
      paradigm: "relational",
      specialization: {
        marker: "surfaced-specialization",
        package: "@hobo/sql",
        equivalenceClass: "managed-postgres",
        path: "resources.db.paradigm",
      },
      portability: {
        specializationMarkers: [
          {
            source: "paradigm-package",
            package: "@hobo/sql",
            marker: "surfaced-specialization",
            equivalenceClass: "managed-postgres",
            path: "resources.db.paradigm",
            reason: "developer opted into @hobo/sql over portable data() default",
          },
        ],
      },
    });
  });

  it("binds each canonical paradigm package to its fixed paradigm identity", () => {
    const cases = [
      ["sql", hoboSql, "relational", undefined],
      ["documents", hoboDocument, "document", undefined],
      ["vectors", hoboVector, "vector", "hobo:search"],
      ["graph", hoboGraph, "graph", "hobo:search"],
    ];

    for (const [name, packageDescriptor, paradigm, extensionPort] of cases) {
      const handle = data(name).use(packageDescriptor);
      const manifest = createManifest([handle]);

      assert.equal(manifest.resources[name].port, "hobo:data");
      assert.equal(manifest.resources[name].paradigm, paradigm);
      assert.equal(manifest.resources[name].specialization.package, packageDescriptor.packageName);

      if (extensionPort) {
        assert.deepEqual(manifest.resources[name].extensions, [
          {
            source: "paradigm-package",
            package: packageDescriptor.packageName,
            port: extensionPort,
            features: packageDescriptor.features.map((feature) => feature.name).sort(),
          },
        ]);
      } else {
        assert.equal("extensions" in manifest.resources[name], false);
      }
    }
  });

  it("rejects package descriptors whose name and paradigm identity do not match", () => {
    assert.throws(
      () =>
        importParadigmPackage({
          packageName: "@hobo/sql",
          paradigm: "document",
          equivalenceClass: "managed-document",
          port: "hobo:data",
        }),
      /package\.paradigm: @hobo\/sql must declare paradigm=relational/,
    );
  });

  it("rejects mixing two paradigm packages on the same data resource", () => {
    assert.throws(
      () => data("db").use(hoboSql).use(hoboDocument),
      (error) => {
        assert.ok(error instanceof AuthoringSurfaceError);
        assert.match(error.message, /resources\.db\.paradigm: already bound to @hobo\/sql/);
        return true;
      },
    );
  });

  it("keeps plain data() portable without paradigm leakage or specialization markers", () => {
    const db = data("db");
    db.read("todo-1");
    const manifest = createManifest([db]);

    assert.equal(manifest.resources.db.port, "hobo:data");
    assert.equal("paradigm" in manifest.resources.db, false);
    assert.equal("specialization" in manifest.resources.db, false);
    assert.equal("portability" in manifest.resources.db, false);
    assert.deepEqual(manifest.resources.db.allow, ["read"]);
  });

  it("flags cross-paradigm-only package features as paradigm-mismatch lock-in markers", () => {
    const embeddings = data("embeddings").use(hoboVector);
    const lowering = embeddings.query({ nearest: "order" });
    const manifest = createManifest([embeddings]);

    assert.deepEqual(lowering.portRef, ["hobo:data"]);
    assert.deepEqual(lowering.extensionPortRef, ["hobo:search"]);
    assert.deepEqual(manifest.resources.embeddings.extensions, [
      {
        source: "paradigm-package",
        package: "@hobo/vector",
        port: "hobo:search",
        features: ["ann-index"],
      },
    ]);
    assert.deepEqual(manifest.resources.embeddings.portability.lockInMarkers, [
      {
        category: "paradigm-mismatch",
        source: "paradigm-package-feature",
        package: "@hobo/vector",
        feature: "ann-index",
        path: "resources.embeddings.features.ann-index",
        reason: "feature has no cross-paradigm equivalent",
        severity: "blocking",
      },
    ]);
  });

  it("does not let imported Data Plane packages bypass allow or collection inference", () => {
    const db = data("db").use(hoboSql);
    db.query({ by: "email" });
    db.read("customer-1");
    const manifest = createManifest([db]);

    assert.deepEqual(manifest.resources.db.allow, ["query", "read"]);
    assert.deepEqual(manifest.resources.db.usage, {
      inferred: ["query", "read"],
      source: "run-to-collect",
    });
    assert.deepEqual(manifest.resources.db.collection, {
      stableId: "data:db",
    });
  });

  it("keeps native pins, Resource Definitions, and raw dialect access reachable after opt-in", () => {
    const db = data("db")
      .use(hoboSql)
      .with(awsRdsNativePin)
      .resourceDefinition("platform/prod-postgres");
    const rawRead = db.raw("postgres", { sql: "select * from customers where id = $1" });
    const manifest = createManifest([db]);

    assert.deepEqual(rawRead.portRef, ["hobo:data"]);
    assert.equal(rawRead.verb, "query");
    assert.deepEqual(rawRead.raw, {
      dialect: "postgres",
      operation: { sql: "select * from customers where id = $1" },
      mode: "read-only",
    });
    assert.deepEqual(manifest.resources.db.annotations.with, {
      "aws.rds": {
        engine: "postgres",
        instanceClass: "db.r7g.large",
      },
    });
    assert.deepEqual(manifest.resources.db.overrides, {
      resourceDefinitionRefs: ["platform/prod-postgres"],
    });
    assert.deepEqual(manifest.resources.db.raw, {
      dialects: ["postgres"],
      mode: "read-only",
    });
    assert.deepEqual(manifest.resources.db.portability.lockInMarkers, [
      {
        source: ".with()",
        annotation: "aws.rds",
        provider: "aws",
        path: "resources.db.annotations.with.aws.rds",
        reason: "provider-specific option is additive but non-portable",
      },
      {
        source: "Resource Definition",
        reference: "platform/prod-postgres",
        path: "resources.db.overrides.resourceDefinitionRefs",
        reason: "resource mapping override is explicit and must be surfaced",
      },
      {
        source: ".raw()",
        dialect: "postgres",
        path: "resources.db.raw.postgres",
        reason: "raw dialect access is non-portable and read-only on projected data",
      },
    ]);
  });

  it("imports package descriptors without redeclaring Data Plane package symbols", async () => {
    assert.equal("sql" in authoring, false);
    assert.equal("vector" in authoring, false);
    assert.equal("graph" in authoring, false);
    assert.equal("document" in authoring, false);
    assert.equal(hoboSql.kind, "hobo.paradigm-package");

    const declarations = await readFile(
      join(import.meta.dirname, "..", "src", "data-paradigm-authoring.d.mts"),
      "utf8",
    );
    assert.doesNotMatch(declarations, /export function sql\(/);
    assert.doesNotMatch(declarations, /export function vector\(/);
    assert.doesNotMatch(declarations, /export function graph\(/);
    assert.doesNotMatch(declarations, /export function document\(/);
    assert.match(declarations, /export function importParadigmPackage/);
  });
});
