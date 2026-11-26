import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createOciComponentHostImage,
  createRuntimeLocalFixture,
  createWasmInContainerHost,
  runComponentHostEquivalence,
  validateOciComponentHostImage,
} from "../src/component-host-oci-floor.js";

test("packages a Wasmtime component-host as an OCI image descriptor with manifest-carried runtime inputs", () => {
  const fixture = createRuntimeLocalFixture();
  const image = createOciComponentHostImage({
    imageRef: "oci://yard/runtime/component-host:dev",
    manifest: fixture.manifest,
  });

  assert.deepEqual(image.runtime, {
    hostKind: "wasm-in-container",
    engine: "wasmtime",
    hostVersion: "46.0.1",
    infra: ["container-runtime"],
  });
  assert.deepEqual(image.manifest.endpoints, fixture.manifest.endpoints);
  assert.deepEqual(image.manifest.links, fixture.manifest.links);
  assert.deepEqual(image.manifest.config, fixture.manifest.config);
  assert.equal(image.oci.manifest.artifactType, "application/vnd.hobo.component-host.oci.v1+json");
  assert.equal(validateOciComponentHostImage(image).ok, true);
});

test("in-container host runs the same component fixture and serves a request with zero new infra", async () => {
  const fixture = createRuntimeLocalFixture();
  const image = createOciComponentHostImage({
    imageRef: "oci://yard/runtime/component-host:dev",
    manifest: fixture.manifest,
  });
  const host = createWasmInContainerHost({ image });

  const boot = host.boot();
  const response = await host.handleHttp("api", {
    method: "GET",
    path: "/healthz",
    headers: [],
    body: "",
  });

  assert.deepEqual(boot, {
    imageRef: "oci://yard/runtime/component-host:dev",
    infra: ["container-runtime"],
    loadedComponents: ["api"],
    establishedLinks: ["api:wasi:http/outgoing-handler@0.2.0->local-http"],
  });
  assert.deepEqual(response, {
    status: 200,
    headers: [["x-provider", "wasm-in-container"]],
    body: "guest:provider:/healthz",
  });
  assert.equal(host.events.some((event) => event.type === "container.Started"), true);
});

test("component-host conformance compares runtime-local and wasm-in-container behavior, not bit identity", async () => {
  const fixture = createRuntimeLocalFixture();
  const image = createOciComponentHostImage({
    imageRef: "oci://yard/runtime/component-host:dev",
    manifest: fixture.manifest,
  });

  const report = await runComponentHostEquivalence({
    fixture,
    containerImage: image,
    request: { method: "GET", path: "/healthz", headers: [], body: "" },
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.assertedProperties, [
    "wasi:http round-trip",
    "link late-binding",
    "manifest-pinned host kind/version",
    "container zero-infra boundary",
  ]);
  assert.deepEqual(report.nonCoveredDivergences, ["container startup latency", "wall-clock scheduling jitter"]);
});

test("conformance fails when the container host diverges from runtime-local behavior", async () => {
  const fixture = createRuntimeLocalFixture();
  const image = createOciComponentHostImage({
    imageRef: "oci://yard/runtime/component-host:dev",
    manifest: fixture.manifest,
  });

  await assert.rejects(
    () =>
      runComponentHostEquivalence({
        fixture,
        containerImage: image,
        request: { method: "GET", path: "/healthz", headers: [], body: "" },
        containerOverrides: {
          providerHeader: "diverged-container",
        },
      }),
    /component_host_oci.conformance_diverged: wasi:http round-trip/,
  );
});

test("invalid OCI host package fails closed before a Camp can select it", () => {
  const fixture = createRuntimeLocalFixture();
  const image = createOciComponentHostImage({
    imageRef: "oci://yard/runtime/component-host:dev",
    manifest: fixture.manifest,
  });

  assert.throws(
    () =>
      validateOciComponentHostImage({
        ...image,
        runtime: { ...image.runtime, engine: "jco-in-node" },
      }),
    /component_host_oci.unsupported_engine: jco-in-node/,
  );
  assert.throws(
    () =>
      validateOciComponentHostImage({
        ...image,
        manifest: { ...image.manifest, links: [] },
      }),
    /component_host_oci.manifest_links_required/,
  );
});
