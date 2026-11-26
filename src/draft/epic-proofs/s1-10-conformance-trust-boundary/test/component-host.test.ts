import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ComponentHostPlanningError,
  createReferenceComponentHostManifest,
  createReferenceInContainerHost,
  createReferenceRuntimeLocalHost,
  planComponentHost,
  runComponentHostConformance,
} from "../src/component-host/index.js";

test("runtime-local and wasm-in-container hosts pass the component-host conformance boundary", async () => {
  const report = await runComponentHostConformance({
    manifest: createReferenceComponentHostManifest(),
    hosts: [
      createReferenceRuntimeLocalHost(),
      createReferenceInContainerHost(),
    ],
  });

  assert.equal(report.schema, "@hobo/conformance/component-host/v1");
  assert.equal(report.status, "pass");
  assert.deepEqual(
    report.hosts.map((host) => [host.kind, host.version, host.status]),
    [
      ["runtime-local", "wasmtime/46.0.1", "pass"],
      ["wasm-in-container", "wasmtime-container/46.0.1", "pass"],
    ],
  );
  assert.deepEqual(report.crossHostAssertions, {
    manifestHostCoverage: "pass",
    deterministicClockReplay: "pass",
    wasiRoundTrip: "pass",
    linkLateBinding: "pass",
    capabilityHandleIsolation: "pass",
    fpNanCanonicalization: "pass",
    fuelEpochScheduling: "pass",
    resourceLimitSemantics: "pass",
  });
  assert.deepEqual(report.nonCoveredDivergences, [
    "wall-clock scheduling jitter",
    "host-specific partial-failure timing",
  ]);
});

test("all manifest-certified host kind/version pairs must be exercised", async () => {
  const report = await runComponentHostConformance({
    manifest: createReferenceComponentHostManifest(),
    hosts: [
      createReferenceRuntimeLocalHost(),
      createReferenceRuntimeLocalHost(),
    ],
  });

  assert.equal(report.status, "fail");
  assert.equal(report.crossHostAssertions.manifestHostCoverage, "fail");
  assert.deepEqual(
    report.failures.find((failure) => failure.checkId === "manifest-host-coverage").missingHosts,
    [{ kind: "wasm-in-container", version: "wasmtime-container/46.0.1" }],
  );
});

test("manifest IR pins host kind and version before a component-host may plan", () => {
  const manifest = createReferenceComponentHostManifest();
  const staleWasmtime = createReferenceRuntimeLocalHost({ version: "wasmtime/45.0.0" });

  assert.throws(
    () => planComponentHost(manifest, staleWasmtime),
    (error) =>
      error instanceof ComponentHostPlanningError &&
      error.code === "component_host.host-version-incompatible" &&
      error.hostKind === "runtime-local" &&
      error.hostVersion === "wasmtime/45.0.0" &&
      error.expectedVersions.includes("wasmtime/46.0.1"),
  );
});

test("identical but wrong WASI round-trip behavior fails the expected semantics", async () => {
  const runtimeLocal = createReferenceRuntimeLocalHost();
  const inContainer = createReferenceInContainerHost();
  const wrongRoundTrip = (request) => ({
    interface: request.interface,
    version: request.version,
    request: {},
    response: {
      ok: true,
      value: "wasi:wrong-key",
    },
  });
  runtimeLocal.roundTripWasiInterface = wrongRoundTrip;
  inContainer.roundTripWasiInterface = wrongRoundTrip;

  const report = await runComponentHostConformance({
    manifest: createReferenceComponentHostManifest(),
    hosts: [runtimeLocal, inContainer],
  });

  assert.equal(report.status, "fail");
  assert.equal(report.crossHostAssertions.wasiRoundTrip, "fail");
  assert.equal(
    report.failures.find((failure) => failure.checkId === "wasi-round-trip").message,
    "wasi-round-trip did not match expected reference semantics",
  );
});

test("deterministic-clock replay drift fails an explicit replay assertion", async () => {
  const report = await runComponentHostConformance({
    manifest: createReferenceComponentHostManifest(),
    hosts: [
      createReferenceRuntimeLocalHost(),
      createReferenceInContainerHost({ deterministicClockOffsetMs: 1 }),
    ],
  });

  assert.equal(report.status, "fail");
  assert.equal(report.crossHostAssertions.deterministicClockReplay, "fail");
  assert.equal(report.failures[0].checkId, "deterministic-clock-replay");
});

test("NaN bit drift fails an explicit fp canonicalization assertion", async () => {
  const report = await runComponentHostConformance({
    manifest: createReferenceComponentHostManifest(),
    hosts: [
      createReferenceRuntimeLocalHost(),
      createReferenceInContainerHost({ nanBits: "0x7ff0000000000001" }),
    ],
  });

  assert.equal(report.status, "fail");
  assert.equal(report.crossHostAssertions.fpNanCanonicalization, "fail");
  assert.equal(report.failures[0].checkId, "fp-nan-canonicalization");
});

test("fuel/epoch scheduling drift fails an explicit scheduling assertion", async () => {
  const report = await runComponentHostConformance({
    manifest: createReferenceComponentHostManifest(),
    hosts: [
      createReferenceRuntimeLocalHost(),
      createReferenceInContainerHost({
        fuelSchedule: [
          { epoch: 0, fuelRemaining: 8, step: "load" },
          { epoch: 1, fuelRemaining: 0, step: "yield" },
        ],
      }),
    ],
  });

  assert.equal(report.status, "fail");
  assert.equal(report.crossHostAssertions.fuelEpochScheduling, "fail");
  assert.equal(report.failures[0].checkId, "fuel-epoch-scheduling");
});

test("resource-limit drift fails an explicit resource semantics assertion", async () => {
  const report = await runComponentHostConformance({
    manifest: createReferenceComponentHostManifest(),
    hosts: [
      createReferenceRuntimeLocalHost(),
      createReferenceInContainerHost({
        resourceLimit: {
          memoryPages: 17,
          maxMemoryPages: 16,
          status: "continued",
          trap: null,
        },
      }),
    ],
  });

  assert.equal(report.status, "fail");
  assert.equal(report.crossHostAssertions.resourceLimitSemantics, "fail");
  assert.equal(report.failures[0].checkId, "resource-limit-semantics");
});

test("ambient provider reachability fails capability-handle isolation", async () => {
  const report = await runComponentHostConformance({
    manifest: createReferenceComponentHostManifest(),
    hosts: [
      createReferenceRuntimeLocalHost(),
      createReferenceInContainerHost({ allowAmbientCapability: true }),
    ],
  });

  assert.equal(report.status, "fail");
  assert.equal(report.crossHostAssertions.capabilityHandleIsolation, "fail");
  assert.equal(report.failures[0].checkId, "capability-handle-isolation");
});
