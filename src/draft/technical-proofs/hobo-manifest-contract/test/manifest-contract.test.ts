import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  CURRENT_MANIFEST_SCHEMA,
  canonicalManifestHash,
  parseManifestReference,
  parseOutputPlaceholder,
  upcastManifest,
  validateManifest,
} from "../src/manifest.js";

const goldenManifest = {
  schema: "hobo.manifest/v1",
  componentHost: {
    kind: "wasmtime",
    version: "1.0.0",
  },
  resources: {
    db: {
      type: "data.v1",
      port: "hobo:data",
      paradigm: "relational",
      allow: ["query"],
      connectionString: "{db.connectionString}",
    },
    api: {
      type: "component.v1",
      image: "oci://registry.example.com/api@sha256:abc123",
      runtime: "wasm",
      exports: ["wasi:http/incoming-handler"],
      links: [{ import: "hobo:data", to: "db" }],
      endpoints: {
        http: { scheme: "http", targetPort: 8080, external: true },
      },
      env: {
        ConnectionStrings__db: "{db.connectionString}",
        SERVICE_REF:
          "${resources.data.postgres#db.outputs.connectionString}",
      },
      annotations: {
        scaling: { min: 1, max: 10 },
        with: { "aws.fargate": { cpu: 512 } },
      },
    },
    site: {
      type: "website.v1",
      bind: ["api"],
    },
  },
};

describe("hobo.manifest/v1 contract", () => {
  it("validates the db/api/site golden manifest and records Aspire fallback env mapping", () => {
    const result = validateManifest(goldenManifest);

    assert.equal(result.valid, true);
    assert.deepEqual(result.aspireEnv, {
      api: ["ConnectionStrings__db"],
    });
  });

  it("rejects malformed manifests with precise paths", () => {
    const missingPort = structuredClone(goldenManifest);
    delete missingPort.resources.db.port;

    assert.throws(
      () => validateManifest(missingPort),
      /resources\.db\.port: required/,
    );

    const unknownType = structuredClone(goldenManifest);
    unknownType.resources.db.type = "queue.v9";

    assert.throws(
      () => validateManifest(unknownType),
      /resources\.db\.type: unknown resource type queue\.v9/,
    );

    const missingVersionMarker = {
      ...structuredClone(goldenManifest),
      schema: CURRENT_MANIFEST_SCHEMA,
    };

    assert.throws(
      () => validateManifest(missingVersionMarker),
      /manifestVersion: required/,
    );
  });

  it("canonicalizes equivalent manifests to the same content hash", () => {
    const reordered = {
      resources: {
        site: goldenManifest.resources.site,
        api: goldenManifest.resources.api,
        db: goldenManifest.resources.db,
      },
      componentHost: {
        version: "1.0.0",
        kind: "wasmtime",
      },
      schema: "hobo.manifest/v1",
    };

    assert.equal(
      canonicalManifestHash(goldenManifest),
      canonicalManifestHash(reordered),
    );
  });

  it("parses lazy tokens and Humanitec placeholders", () => {
    assert.deepEqual(parseManifestReference("{db.connectionString}"), {
      resourceId: "db",
      output: "connectionString",
    });

    assert.deepEqual(
      parseOutputPlaceholder("${resources.data.postgres#db.outputs.url}"),
      {
        type: "data",
        className: "postgres",
        resourceId: "db",
        output: "url",
      },
    );

    assert.deepEqual(parseOutputPlaceholder("${context.environment}"), {
      contextPath: "environment",
    });
  });

  it("fails dangling references and unresolved link imports closed", () => {
    const danglingToken = structuredClone(goldenManifest);
    danglingToken.resources.api.env.ConnectionStrings__missing =
      "{missing.connectionString}";

    assert.throws(
      () => validateManifest(danglingToken),
      /resources\.api\.env\.ConnectionStrings__missing: unknown resource missing/,
    );

    const danglingLink = structuredClone(goldenManifest);
    danglingLink.resources.api.links = [{ import: "hobo:queue", to: "db" }];

    assert.throws(
      () => validateManifest(danglingLink),
      /resources\.api\.links\[0\]\.import: no matching declared resource for hobo:queue/,
    );
  });

  it("upcasts an older manifest through the version registry and preserves deterministic content addressing", () => {
    const result = upcastManifest(goldenManifest);

    assert.equal(result.fromSchema, "hobo.manifest/v1");
    assert.equal(result.toSchema, CURRENT_MANIFEST_SCHEMA);
    assert.deepEqual(result.appliedUpcasters, [
      "hobo.manifest/v1->hobo.manifest/v1.1",
    ]);
    assert.equal(result.manifest.schema, CURRENT_MANIFEST_SCHEMA);
    assert.deepEqual(result.manifest.manifestVersion, {
      upcastedFrom: "hobo.manifest/v1",
    });
    assert.equal(validateManifest(result.manifest).schema, CURRENT_MANIFEST_SCHEMA);
    assert.equal(result.hash, canonicalManifestHash(result.manifest));
    assert.equal(upcastManifest(goldenManifest).hash, result.hash);
  });

  it("fails unsafe upcaster edges closed and keeps current manifests idempotent", () => {
    const current = upcastManifest(goldenManifest).manifest;
    const noOp = upcastManifest(current);

    assert.deepEqual(noOp.appliedUpcasters, []);
    assert.equal(noOp.hash, canonicalManifestHash(current));

    assert.throws(
      () => upcastManifest({ ...goldenManifest, schema: "hobo.manifest/v9" }),
      /schema: unknown manifest schema hobo\.manifest\/v9/,
    );

    assert.throws(
      () =>
        upcastManifest(goldenManifest, {
          targetSchema: "hobo.manifest/v1.2",
          schemaOrder: [
            "hobo.manifest/v1",
            "hobo.manifest/v1.1",
            "hobo.manifest/v1.2",
          ],
        }),
      /schema: missing upcaster from hobo\.manifest\/v1\.1 to hobo\.manifest\/v1\.2/,
    );

    assert.throws(
      () =>
        upcastManifest(goldenManifest, {
          targetSchema: "hobo.manifest/v1.2",
          schemaOrder: [
            "hobo.manifest/v1",
            "hobo.manifest/v1.1",
            "hobo.manifest/v1.2",
          ],
          upcasters: [
            {
              from: "hobo.manifest/v1",
              to: "hobo.manifest/v1.2",
              upcast(manifest) {
                return {
                  ...manifest,
                  schema: "hobo.manifest/v1.2",
                  manifestVersion: { upcastedFrom: manifest.schema },
                };
              },
            },
          ],
        }),
      /schema: missing intermediate upcaster from hobo\.manifest\/v1 to hobo\.manifest\/v1\.1/,
    );

    assert.throws(
      () =>
        upcastManifest(goldenManifest, {
          upcasters: [
            {
              from: "hobo.manifest/v1",
              to: "hobo.manifest/v1.1",
              upcast(manifest) {
                const next = structuredClone(manifest);
                next.schema = "hobo.manifest/v1.1";
                delete next.resources.db.connectionString;
                return next;
              },
            },
          ],
        }),
      /lossy upcaster hobo\.manifest\/v1->hobo\.manifest\/v1\.1 removed resources\.db\.connectionString without recording loss/,
    );
  });
});
