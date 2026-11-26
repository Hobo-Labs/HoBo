import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  aspireConnectionStringKey,
  aspireServiceEndpointKey,
  assertManifestWiringUnchangedOnRuntimeSwap,
  assertWiringParity,
  createMultiCloudShopWiringFixture,
  projectWiringSurface,
  runContainerFallbackWiringConformance,
} from "../src/container-fallback-wiring-parity.js";

describe("container fallback wiring parity contract", () => {
  it("multi-cloud-shop wasm and container fixtures share bind links and ConnectionStrings env", () => {
    const wasm = createMultiCloudShopWiringFixture("wasm");
    const container = createMultiCloudShopWiringFixture("container");

    assertWiringParity(wasm, container, ["api", "frontend"]);

    assert.deepEqual(wasm.resources.api.links, [
      { import: "hobo:data", to: "orders" },
      { import: "hobo:data", to: "assets" },
    ]);
    assert.equal(
      wasm.resources.api.env[aspireConnectionStringKey("orders")],
      "{orders.connectionString}",
    );
    assert.equal(
      container.resources.api.env[aspireConnectionStringKey("assets")],
      "{assets.connectionString}",
    );
  });

  it("projects Aspire services__ endpoint env for wasm and container runtimes", () => {
    const wasm = createMultiCloudShopWiringFixture("wasm");
    const container = createMultiCloudShopWiringFixture("container");

    for (const manifest of [wasm, container]) {
      assert.equal(
        manifest.resources.api.env[aspireServiceEndpointKey("api", "http")],
        "{api.endpoints.http.url}",
      );
      assert.equal(
        manifest.resources.api.env[aspireServiceEndpointKey("api", "http", 1)],
        "8080",
      );
    }
  });

  it("keeps ctx.config tokens identical across runtime modes", () => {
    const wasm = createMultiCloudShopWiringFixture("wasm");
    const container = createMultiCloudShopWiringFixture("container");

    const wasmApi = projectWiringSurface(wasm, "api");
    const containerApi = projectWiringSurface(container, "api");

    assert.equal(wasmApi.env.SHOP_REGION, "${context.region}");
    assert.equal(containerApi.env.FEATURE_CHECKOUT, "${context.flags.checkout}");
    assert.equal(wasmApi.config.ORDERS_DB, "{orders.connectionString}");
    assert.equal(containerApi.config.STRIPE_KEY, "{secret.stripe/api-key}");
  });

  it("swaps component to container with zero non-runtime manifest edits", () => {
    const wasm = createMultiCloudShopWiringFixture("wasm");
    const swapped = assertManifestWiringUnchangedOnRuntimeSwap(wasm, "container");

    assert.equal(swapped.resources.api.runtime, "container");
    assert.equal(swapped.resources.api.build.provider, "hobo:build-dagger");
    assert.equal(swapped.resources.api.exports, undefined);
    assert.equal(swapped.resources.orders.type, wasm.resources.orders.type);
  });

  it("swaps container back to wasm without changing wiring assertions", () => {
    const container = createMultiCloudShopWiringFixture("container");
    const swapped = assertManifestWiringUnchangedOnRuntimeSwap(container, "wasm");

    assert.equal(swapped.resources.api.runtime, "wasm");
    assert.deepEqual(swapped.resources.api.exports, ["wasi:http/incoming-handler"]);
    assert.equal(swapped.resources.api.build, undefined);
  });

  it("runContainerFallbackWiringConformance gates the multi-cloud-shop fixture", () => {
    const report = runContainerFallbackWiringConformance();

    assert.equal(report.ok, true);
    assert.equal(report.fixture, "examples/multi-cloud-shop");
    assert.deepEqual(report.services, ["api", "frontend"]);
    assert.match(report.assertions.join(","), /runtime-swap-zero-manifest-edits/);
  });

  it("fails closed when a runtime swap mutates bind wiring", () => {
    const wasm = createMultiCloudShopWiringFixture("wasm");
    const container = createMultiCloudShopWiringFixture("container");
    container.resources.api.env.ConnectionStrings__orders = "{orders.host}";

    assert.throws(
      () => assertWiringParity(wasm, container, ["api"]),
      /resources\.api\.wiring: wiring surfaces diverged/,
    );
  });

  it("rejects manifests that drop config tokens on the container path only", () => {
    const wasm = createMultiCloudShopWiringFixture("wasm");
    const container = createMultiCloudShopWiringFixture("container");
    delete container.resources.api.env.SHOP_REGION;

    assert.throws(
      () => assertWiringParity(wasm, container, ["api"]),
      /resources\.api\.wiring: wiring surfaces diverged/,
    );
  });

  it("projects binding and secret-ref config entries from the multi-cloud-shop fixture", () => {
    const wasm = createMultiCloudShopWiringFixture("wasm");
    const apiWiring = projectWiringSurface(wasm, "api");

    assert.deepEqual(apiWiring.config, {
      ASSETS_STORE: "{assets.connectionString}",
      FEATURE_CHECKOUT: "${context.flags.checkout}",
      ORDERS_DB: "{orders.connectionString}",
      SHOP_REGION: "${context.region}",
      STRIPE_KEY: "{secret.stripe/api-key}",
    });
  });

  it("fails closed when services__ endpoint env drifts on the container path", () => {
    const wasm = createMultiCloudShopWiringFixture("wasm");
    const container = createMultiCloudShopWiringFixture("container");
    container.resources.api.env[aspireServiceEndpointKey("api", "http", 1)] = "9090";

    assert.throws(
      () => assertWiringParity(wasm, container, ["api"]),
      /resources\.api\.wiring: wiring surfaces diverged/,
    );
  });
});
