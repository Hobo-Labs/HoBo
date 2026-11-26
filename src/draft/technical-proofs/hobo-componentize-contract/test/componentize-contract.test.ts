import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  DEFAULT_CI_MATRIX,
  DEFAULT_TOOLCHAIN,
  componentizeHelloBindle,
  runWasmtimeSmoke,
  validateWasmComponentArtifact,
} from "../src/componentize-contract.js";

const HELLO_BINDLE_ROOT = new URL("../examples/hello-bindle", import.meta.url);

test("hello-bindle builds to a wasm component artifact and OCI descriptor", async () => {
  const result = await componentizeHelloBindle({
    sourceRoot: HELLO_BINDLE_ROOT,
    sourceDateEpoch: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(result.component.path, "dist/hello-bindle.component.wasm");
  assert.equal(result.component.mediaType, "application/vnd.wasm.component.v1+wasm");
  assert.match(result.component.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.component.witWorld, "hobo:examples/hello-bindle@0.1.0/service");

  assert.deepEqual(validateWasmComponentArtifact(result.component), {
    command: "wasm-tools validate dist/hello-bindle.component.wasm",
    passed: true,
    format: "wasm-component-contract",
  });
  assert.equal(result.oci.artifactType, "application/vnd.wasm.component.v1+wasm");
  assert.equal(result.oci.manifest.layers[0].digest, result.component.digest);
  assert.equal(result.oci.manifest.annotations["org.opencontainers.image.title"], "hello-bindle");
});

test("rebuilds are byte-identical through pinned nondeterminism controls", async () => {
  const first = await componentizeHelloBindle({
    sourceRoot: HELLO_BINDLE_ROOT,
    sourceDateEpoch: "2026-01-01T00:00:00.000Z",
  });
  const second = await componentizeHelloBindle({
    sourceRoot: HELLO_BINDLE_ROOT,
    sourceDateEpoch: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(second.component.digest, first.component.digest);
  assert.deepEqual(second.component.bytes, first.component.bytes);
  assert.deepEqual(first.reproducibility.controls, [
    "SOURCE_DATE_EPOCH",
    "sorted source file list",
    "workspace path remap",
    "pinned jco/componentize-js/wasm-tools/wasmtime versions",
  ]);
  assert.deepEqual(first.ciMatrix, DEFAULT_CI_MATRIX);
  assert.equal(first.ciMatrix.toolchain.componentizeJs, "0.21.0");
  assert.deepEqual(first.ciMatrix.os, ["ubuntu-latest", "windows-latest"]);
});

test("wasmtime-shaped smoke test runs the component health export", async () => {
  const result = await componentizeHelloBindle({
    sourceRoot: HELLO_BINDLE_ROOT,
    sourceDateEpoch: "2026-01-01T00:00:00.000Z",
  });

  assert.deepEqual(await runWasmtimeSmoke(result.component, { exportName: "health" }), {
    command: "wasmtime run dist/hello-bindle.component.wasm --invoke health",
    engine: "wasmtime",
    exitCode: 0,
    stdout: "hello-bindle:ok\n",
  });
});

test("toolchain skew and nondeterministic service sources fail closed", async () => {
  await assert.rejects(
    () =>
      componentizeHelloBindle({
        sourceRoot: HELLO_BINDLE_ROOT,
        sourceDateEpoch: "2026-01-01T00:00:00.000Z",
        toolchain: { ...DEFAULT_TOOLCHAIN, jco: "1.24.4" },
      }),
    /componentize\.toolchain_skew: jco expected 1\.24\.3 got 1\.24\.4/,
  );

  await withTempFixture(async (root) => {
    await writeFile(
      join(root, "src", "service.ts"),
      'export const builtAt = Date.now();\nexport function health() { return { status: 200, body: "bad" }; }\n',
    );

    await assert.rejects(
      () =>
        componentizeHelloBindle({
          sourceRoot: root,
          sourceDateEpoch: "2026-01-01T00:00:00.000Z",
        }),
      /componentize\.nondeterministic_source: Date\.now/,
    );
  });
});

async function withTempFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "hobo-componentize-"));
  await mkdir(join(root, "src"), { recursive: true });
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
