import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createReferenceIacBackend,
  realizeFixtureProvider,
  wireBuildOutputs,
} from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import {
  BUILD_WASM_PROVIDER_ID,
  createBuildWasmProvider,
  createFixtureWasmBuildSpec,
  runBuildWasmConformance,
} from "../src/build-wasm-provider.js";

test("@hobo/build-wasm builds a deterministic wasm-component OCI ImageRef", async () => {
  const provider = createBuildWasmProvider();
  const spec = createFixtureWasmBuildSpec();

  const first = await provider.build(spec);
  const second = await provider.build(spec);

  assert.equal(provider.id, BUILD_WASM_PROVIDER_ID);
  assert.equal(first.kind, "ImageRef");
  assert.equal(first.provider, BUILD_WASM_PROVIDER_ID);
  assert.equal(first.ref, second.ref);
  assert.equal(first.component.digest, second.component.digest);
  assert.equal(first.component.mediaType, "application/vnd.wasm.component.v1+wasm");
  assert.equal(first.component.componentModel, "wit-component");
  assert.equal(first.component.witWorld, "hobo:examples/hello-bindle@0.1.0/service");
  assert.equal(first.manifest.layers[0].digest, first.component.digest);
  assert.equal(first.provenance.toolchain.jco, "1.24.3");
  assert.equal(
    first.provenance.toolchain.digests.jco,
    "sha256:4db7465bc949508edb46cadb2dddb2f8da3a8afec4f3c07e0a0f1fda47b0b83d",
  );
  assert.equal(first.provenance.languageToolchain, "jco+componentize-js");
  assert.equal(first.provenance.sourceDateEpoch, "2026-01-01T00:00:00.000Z");
});

test("registered source languages route through their declared wasm toolchains", async () => {
  const provider = createBuildWasmProvider();
  const rust = await provider.build(
    createFixtureWasmBuildSpec({
      id: "rust-worker-image",
      source: {
        path: "services/worker",
        language: "rust",
        entrypoint: "src/lib.rs",
        witWorld: "hobo:examples/worker@0.1.0/service",
      },
    }),
  );
  const tinygo = await provider.build(
    createFixtureWasmBuildSpec({
      id: "tinygo-worker-image",
      source: {
        path: "services/tinygo-worker",
        language: "tinygo",
        entrypoint: "main.go",
        witWorld: "hobo:examples/tinygo-worker@0.1.0/service",
      },
    }),
  );

  assert.equal(rust.provenance.languageToolchain, "cargo-component");
  assert.equal(tinygo.provenance.languageToolchain, "tinygo");
  assert.notEqual(rust.ref, tinygo.ref);
});

test("BuildProvider ImageRef wires back into the fixture provider IacProgram", async () => {
  const provider = createBuildWasmProvider();
  const emission = realizeFixtureProvider();
  const artifact = emission.build.artifacts[0];
  const imageRef = await provider.build(
    createFixtureWasmBuildSpec({
      id: artifact.id,
      source: { path: artifact.source, language: "typescript" },
      target: artifact.target,
    }),
  );

  const wired = wireBuildOutputs(emission, {
    [artifact.id]: imageRef.ref,
  });
  const apiNode = wired.iac.nodes.find((node) => node.id === "api");

  assert.deepEqual(apiNode.inputs.image, {
    artifactId: "api-image",
    imageRef: imageRef.ref,
  });
  assert.equal(createReferenceIacBackend().accept(wired).accepted, true);
});

test("build-wasm conformance gates claimed wasm BuildProvider behavior", async () => {
  const provider = createBuildWasmProvider();
  const report = await runBuildWasmConformance(provider, {
    wireImageRef: wireImageRefIntoFixtureProvider,
  });

  assert.equal(report.passed, true, report.failures.join("\n"));
  assert.deepEqual(report.coverage, [
    "build.wasm-component",
    "image-ref.reproducible",
    "image-ref.iac-wireback",
    "target.fail-closed",
  ]);

  const drifting = createBuildWasmProvider({
    componentizer: createDriftingComponentizer(),
  });

  await assert.rejects(
    () =>
      runBuildWasmConformance(drifting, {
        wireImageRef: wireImageRefIntoFixtureProvider,
      }),
    {
      name: "BuildWasmError",
      code: "non-reproducible-build",
    },
  );
});

test("non-wasm targets and missing source toolchains fail with precise errors", async () => {
  const provider = createBuildWasmProvider();

  await assert.rejects(() => provider.build(createFixtureWasmBuildSpec({ target: "container" })), {
    name: "BuildWasmError",
    code: "unsupported-target",
    message: /target container is not wasm-component/,
  });

  await assert.rejects(
    () =>
      provider.build(
        createFixtureWasmBuildSpec({
          source: { path: "services/ml", language: "python" },
        }),
      ),
    {
      name: "BuildWasmError",
      code: "missing-toolchain",
      message: /no wasm toolchain registered for python/,
    },
  );
});

test("toolchain drift, invalid components, and oversize components fail closed", async () => {
  await assert.rejects(
    () =>
      createBuildWasmProvider().build(
        createFixtureWasmBuildSpec({
          toolchain: { jco: "1.24.4", componentizeJs: "0.21.0", wasmTools: "1.235.0" },
        }),
      ),
    {
      name: "BuildWasmError",
      code: "toolchain-drift",
      message: /jco expected 1\.24\.3 got 1\.24\.4/,
    },
  );

  await assert.rejects(
    () =>
      createBuildWasmProvider().build(
        createFixtureWasmBuildSpec({
          toolchain: {
            digests: {
              jco: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            },
          },
        }),
      ),
    {
      name: "BuildWasmError",
      code: "toolchain-drift",
      message: /jco digest expected sha256:4db7465/,
    },
  );

  await assert.rejects(
    () =>
      createBuildWasmProvider({
        componentizer: async () => ({ bytes: Buffer.from("not wasm") }),
      }).build(createFixtureWasmBuildSpec()),
    {
      name: "BuildWasmError",
      code: "invalid-component",
    },
  );

  await assert.rejects(
    () =>
      createBuildWasmProvider({
        componentizer: async () => ({ bytes: coreWasmModuleBytes() }),
      }).build(createFixtureWasmBuildSpec()),
    {
      name: "BuildWasmError",
      code: "invalid-component",
    },
  );

  await assert.rejects(
    () =>
      createBuildWasmProvider({
        componentizer: async () => ({
          bytes: validWasmComponentBytes(createFixtureWasmBuildSpec(), { extra: "x".repeat(4096) }),
        }),
      }).build(createFixtureWasmBuildSpec({ sizeBudgetBytes: 128 })),
    {
      name: "BuildWasmError",
      code: "component-size-budget-exceeded",
    },
  );
});

function createDriftingComponentizer() {
  let counter = 0;
  return async (spec) => ({
    bytes: validWasmComponentBytes(spec, { nonce: counter++ }),
  });
}

async function wireImageRefIntoFixtureProvider(imageRef, spec) {
  const emission = realizeFixtureProvider();
  const wired = wireBuildOutputs(emission, {
    [spec.id]: imageRef.ref,
  });
  const apiNode = wired.iac.nodes.find((node) => node.id === spec.iacProgramRef.nodeId);
  const accepted = createReferenceIacBackend().accept(wired).accepted;

  return {
    accepted,
    imageRef: apiNode?.inputs?.image?.imageRef,
  };
}

function validWasmComponentBytes(spec, extra = {}) {
  const metadata = JSON.stringify({
    schema: "hobo.build-wasm.component/v1",
    componentModel: "wit-component",
    artifactId: spec.id,
    witWorld: spec.source.witWorld,
    languageToolchain: toolchainFor(spec.source.language),
    extra,
  });
  const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]);
  const name = Buffer.from("hobo.component", "utf8");
  const data = Buffer.from(metadata, "utf8");
  const payload = Buffer.concat([encodeU32(name.byteLength), name, data]);
  return Buffer.concat([header, Buffer.from([0x00]), encodeU32(payload.byteLength), payload]);
}

function coreWasmModuleBytes() {
  return Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
}

function toolchainFor(language) {
  if (language === "rust") return "cargo-component";
  if (language === "tinygo") return "tinygo";
  return "jco+componentize-js";
}

function encodeU32(value) {
  const bytes = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}
