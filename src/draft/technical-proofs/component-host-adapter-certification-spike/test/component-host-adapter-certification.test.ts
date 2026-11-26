import assert from "node:assert/strict";
import { test } from "vitest";

import {
  applyHostWithOptions,
  certifyComponentHostAdapter,
  createCloudflareWorkersProviderNativeProfile,
  createDeterminismDriftProfile,
  createSpinKubeAdapterProfile,
  createWasmtimeLocalProfile,
  doctorHostWithOptions,
  hostWith,
} from "../src/component-host-adapter-certification.js";

test("SpinKube adapter profile certifies against runtime-local with covered and non-covered divergences", async () => {
  const report = await certifyComponentHostAdapter({
    adapterProfile: createSpinKubeAdapterProfile(),
    hostOptions: [hostWith("spinkube", "linkMigration", { mode: "drain-before-cutover" })],
  });

  assert.equal(report.schema, "hobo.component-host-adapter-certification-spike/v1");
  assert.equal(report.ok, true);
  assert.equal(report.status, "certified");
  assert.equal(report.conformanceReport.status, "pass");
  assert.deepEqual(
    report.coveredDivergences.map((entry) => [entry.id, entry.status]),
    [
      ["manifest-host-coverage", "pass"],
      ["deterministic-clock-replay", "pass"],
      ["wasi-round-trip", "pass"],
      ["link-late-binding", "pass"],
      ["capability-handle-isolation", "pass"],
      ["fp-nan-canonicalization", "pass"],
      ["fuel-epoch-scheduling", "pass"],
      ["resource-limit-semantics", "pass"],
    ],
  );
  assert.deepEqual(report.nonCoveredDivergences, [
    "wall-clock scheduling jitter",
    "host-specific partial-failure timing",
  ]);
  assert.deepEqual(report.hostOptions.applied, [
    {
      host: "spinkube",
      option: 'host.spinkube.with("linkMigration")',
      value: { mode: "drain-before-cutover" },
      status: "applied",
    },
  ]);
  assert.equal(report.doctor.findings[0].code, "component_host.host-lock-in");
});

test("cross-host E2E proves the same component from Wasmtime local to SpinKube", async () => {
  const report = await certifyComponentHostAdapter({
    baselineProfile: createWasmtimeLocalProfile(),
    adapterProfile: createSpinKubeAdapterProfile(),
  });

  assert.deepEqual(report.crossHostE2E.from, {
    kind: "runtime-local",
    version: "wasmtime/46.0.1",
  });
  assert.deepEqual(report.crossHostE2E.to, {
    kind: "spinkube",
    version: "containerd-wasm/spinkube@spike",
  });
  assert.equal(report.crossHostE2E.component, "hobo:examples/hello-bindle@0.1.0/service");
  assert.equal(report.crossHostE2E.equivalentBehavior, true);
  assert.equal(report.crossHostE2E.assertedBy.includes("wasi-round-trip"), true);
  assert.equal(report.crossHostE2E.assertedBy.includes("resource-limit-semantics"), true);
});

test("determinism drift fails the component-host suite instead of passing functionally", async () => {
  const report = await certifyComponentHostAdapter({
    adapterProfile: createDeterminismDriftProfile(),
  });

  assert.equal(report.ok, false);
  assert.equal(report.status, "conformance-failed");
  assert.deepEqual(
    report.gaps.map((gap) => gap.checkId).sort(),
    [
      "fp-nan-canonicalization",
      "fuel-epoch-scheduling",
      "resource-limit-semantics",
    ],
  );
  assert.equal(report.crossHostE2E.equivalentBehavior, false);
});

test("provider-native profile missing required wasi interfaces fails planning with a precise gap list", async () => {
  const report = await certifyComponentHostAdapter({
    adapterProfile: createCloudflareWorkersProviderNativeProfile(),
  });

  assert.equal(report.ok, false);
  assert.equal(report.status, "planning-failed");
  assert.match(report.reason, /component_host\.wasi-interface-missing/);
  assert.deepEqual(
    report.gaps
      .filter((gap) => gap.code === "component_host.wasi-interface-missing")
      .map((gap) => gap.interface),
    [
      "wasi:blobstore/blobstore@0.2.0",
      "wasi:keyvalue/store@0.2.0",
    ],
  );
  assert.equal(report.crossHostE2E.status, "not-run");
  assert.equal(report.crossHostE2E.equivalentBehavior, false);
});

test("host.with options are inert on non-matching hosts and still reported as lock-in", () => {
  const hostOptions = [hostWith("spinkube", "linkMigration", true)];
  const application = applyHostWithOptions({
    adapterProfile: createWasmtimeLocalProfile(),
    hostOptions,
  });
  const doctor = doctorHostWithOptions({ hostOptions });

  assert.deepEqual(application.applied, []);
  assert.deepEqual(application.inert, [
    {
      host: "runtime-local",
      option: 'host.spinkube.with("linkMigration")',
      value: true,
      status: "inert",
      reason: "option belongs to a different component-host kind",
    },
  ]);
  assert.deepEqual(doctor.findings, [
    {
      code: "component_host.host-lock-in",
      severity: "warning",
      source: 'host.spinkube.with("linkMigration")',
      reason: "host-specific option narrows the portability target set",
      remediation: "keep the option typed and include it in the PortabilityReport/doctor output",
    },
  ]);
});
