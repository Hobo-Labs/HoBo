import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  addContainer,
  bindingTypesFor,
  compileBindleManifest,
  data,
  service,
} from "../src/bind-reference-contract.js";

describe("bind reference wiring contract", () => {
  it("records bind edges, capability links, and Aspire env references", () => {
    const db = data("db", { paradigm: "relational" });
    const api = service("api", {
      image: "oci://registry.example.com/api@sha256:abc123",
      bind: { db },
    });

    const manifest = compileBindleManifest([db, api]);

    assert.deepEqual(manifest.resources.api.links, [
      { import: "hobo:data", to: "db" },
    ]);
    assert.equal(
      manifest.resources.api.env.ConnectionStrings__db,
      "{db.connectionString}",
    );
    assert.deepEqual(manifest.resources.api.bindings, {
      db: {
        port: "hobo:data",
        resource: "db",
        clientType: "DataClient",
      },
    });
  });

  it("publishes a generated typed ctx.bindings surface and rejects unbound names", () => {
    const db = data("db");
    const orders = data("orders", { paradigm: "document" });
    const api = service("api", { bind: { db, orders } });

    assert.deepEqual(bindingTypesFor(api), {
      db: "DataClient",
      orders: "DataClient",
    });
    assert.equal(
      api.typescript.ctxBindings,
      [
        "readonly db: DataClient;",
        "readonly orders: DataClient;",
      ].join("\n"),
    );
    assert.equal(api.binding("db").resource, "db");
    assert.throws(
      () => api.binding("missing"),
      /ctx\.bindings\.missing is not declared on service api/,
    );
  });

  it("addContainer records wiring and build annotations in one call", () => {
    const models = data("models", { paradigm: "document" });
    const container = addContainer(
      "cuda-job",
      "ghcr.io/acme/cuda-job:1.2",
      { bind: { models } },
    )
      .withEndpoint({ name: "http", scheme: "http", port: 8080 })
      .withEnvironment("MODEL", "yolo")
      .withVolume("model-cache", "/models")
      .withHttpHealthCheck("/healthz");

    const manifest = compileBindleManifest([models, container]);

    assert.deepEqual(manifest.resources["cuda-job"].links, [
      { import: "hobo:data", to: "models" },
    ]);
    assert.deepEqual(manifest.resources["cuda-job"].build, {
      provider: "hobo:build",
      source: "ghcr.io/acme/cuda-job:1.2",
      defaultArtifact: "wasm-on-oci",
    });
    assert.equal(
      manifest.resources["cuda-job"].env.ConnectionStrings__models,
      "{models.connectionString}",
    );
    assert.equal(manifest.resources["cuda-job"].env.MODEL, "yolo");
    assert.equal(
      manifest.resources["cuda-job"].annotations.health.path,
      "/healthz",
    );
  });

  it("records the full addContainer fluent surface (Scope-in) as annotations", () => {
    const db = data("db");
    const migrations = addContainer("migrations", "ghcr.io/acme/migrate:1");
    const app = addContainer("app", "ghcr.io/acme/app:1", { bind: { db } })
      .withHttpEndpoint(8080, { external: true })
      .withArgs("--serve", "--port=8080")
      .withBindMount("./seed", "/seed", true)
      .withLifetime("persistent")
      .waitFor(db)
      .waitForCompletion(migrations);

    const manifest = compileBindleManifest([db, migrations, app]);
    const resource = manifest.resources.app;

    assert.deepEqual(resource.endpoints.http, {
      scheme: "http",
      port: 8080,
      targetPort: 8080,
      external: true,
      protocol: "tcp",
    });
    assert.deepEqual(resource.annotations.args, ["--serve", "--port=8080"]);
    assert.deepEqual(resource.annotations.bindMounts, [
      { source: "./seed", target: "/seed", readOnly: true },
    ]);
    assert.equal(resource.annotations.lifetime, "persistent");
    assert.deepEqual(resource.annotations.waitFor, [{ to: "db", until: "ready" }]);
    assert.deepEqual(resource.annotations.waitForCompletion, [
      { to: "migrations", until: "completed" },
    ]);
  });

  it("rejects an invalid lifetime and an undeclarable wait dependency", () => {
    assert.throws(
      () => addContainer("app", "ghcr.io/acme/app:1").withLifetime("forever"),
      /lifetime must be one of session, persistent/,
    );
    assert.throws(
      () => addContainer("app", "ghcr.io/acme/app:1").waitFor(42),
      /resources\.app\.waitFor: must reference a declared resource handle or id/,
    );
  });

  it("fails undeclared binds and unresolved lazy references closed", () => {
    const db = data("db");
    const api = service("api", { bind: { db } });

    assert.throws(
      () => compileBindleManifest([api]),
      /resources\.api\.links\[0\]\.to: unknown resource db/,
    );

    const dangling = service("worker", {
      env: { DATABASE_URL: "{missing.connectionString}" },
    });
    assert.throws(
      () => compileBindleManifest([dangling]),
      /resources\.worker\.env\.DATABASE_URL: unknown resource missing/,
    );
  });

  it("keeps cross-Camp and DNS scope out of the bind contract", () => {
    const db = data("db");

    assert.throws(
      () => service("api", { bind: { db }, camp: "prod-aws" }),
      /cross-Camp placement is resolved by enclosing scopes/,
    );
    assert.throws(
      () =>
        addContainer("api", "ghcr.io/acme/api:1").withDnsRecord(
          "api.example.com",
        ),
      /DNS is Yard-level and outside the bind reference contract/,
    );
  });
});
