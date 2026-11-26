/**
 * Executable step definitions for s1-10-conformance-trust-boundary.feature.
 *
 * Drives the epic's real conformance modules — the frozen runtime-port
 * durability suite and the component-host cross-host suite — against the
 * package's own in-memory port fixtures (reference and seeded-violation
 * backends). No live services; this is the S1 trust boundary drawn in code.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import {
  ComponentHostPlanningError,
  createReferenceComponentHostManifest,
  createReferenceInContainerHost,
  createReferenceRuntimeLocalHost,
  planComponentHost,
  runComponentHostConformance,
} from "../../src/component-host/index.js";
import { createBrokenFenceRuntimeBackend } from "../../src/fixtures/broken-fence-backend.js";
import { createRuntimeLocalDurabilityBackend } from "../../src/fixtures/reference-backend.js";
import {
  RUNTIME_PORT_CONFORMANCE_VERSION,
  runRuntimePortDurabilitySuite,
  type RuntimeDurabilityBackend,
  type RuntimePortConformanceReport,
} from "../../src/runtime-port/index.js";

type TrustBoundaryWorld = {
  backendFactory?: () => RuntimeDurabilityBackend;
  durabilityReport?: RuntimePortConformanceReport;
  crossHostReport?: Awaited<ReturnType<typeof runComponentHostConformance>>;
  driftedHost?: ReturnType<typeof createReferenceRuntimeLocalHost>;
  planningError?: unknown;
};

const world: TrustBoundaryWorld = {};

// --- Scenario: Reference runtime backend passes the frozen durability suite --

Given("the S1 trust-boundary runtime-local durability backend", () => {
  world.backendFactory = createRuntimeLocalDurabilityBackend;
  assert.equal(createRuntimeLocalDurabilityBackend().name, "runtime-local");
});

Given("the S1 trust-boundary broken-fence runtime backend", () => {
  world.backendFactory = createBrokenFenceRuntimeBackend;
  assert.equal(createBrokenFenceRuntimeBackend().name, "runtime-local");
});

When(
  "the frozen runtime-port durability suite runs against the trust-boundary backend",
  async () => {
    assert.ok(world.backendFactory, "a durability backend fixture must be given");
    world.durabilityReport = await runRuntimePortDurabilitySuite(world.backendFactory);
  },
);

Then("the trust-boundary durability report passes all five frozen checks", () => {
  const report = world.durabilityReport;
  assert.ok(report, "durability suite must have run");
  assert.equal(report.status, "pass");
  assert.equal(report.checks.length, 5, "the suite is frozen at five checks");
  assert.ok(
    report.checks.every((check) => check.status === "pass"),
    "every frozen check passes on the reference backend",
  );
  assert.ok(
    report.checks.some(
      (check) => check.checkId === "runtime.local.checkout-replay-equals-live",
    ),
    "checkout replay == live is one of the frozen checks",
  );
  assert.deepEqual(report.failures, []);
});

Then(
  "the trust-boundary durability report pins contract {string}",
  (contract: string) => {
    assert.equal(world.durabilityReport?.contract, contract);
    assert.equal(contract, RUNTIME_PORT_CONFORMANCE_VERSION);
  },
);

// --- Scenario: Broken-fence backend is caught by the stale-fence check -------

Then("the trust-boundary durability report fails closed", () => {
  const report = world.durabilityReport;
  assert.ok(report, "durability suite must have run");
  assert.equal(report.status, "fail");
  assert.ok(report.failures.length > 0, "the seeded violation surfaces as a failure");
});

Then("the trust-boundary failure names check {string}", (checkId: string) => {
  const report = world.durabilityReport;
  assert.ok(report);
  assert.ok(
    report.failures.some((failure) => failure.checkId === checkId),
    `failures must name ${checkId}; got ${JSON.stringify(report.failures)}`,
  );
  const check = report.checks.find((entry) => entry.checkId === checkId);
  assert.equal(check?.status, "fail", "the named check is marked failed in the report");
});

// --- Scenario: Certified component hosts pass cross-host conformance ---------

Given("the pinned component-host manifest and both certified host fixtures", async () => {
  world.crossHostReport = await runComponentHostConformance({
    manifest: createReferenceComponentHostManifest(),
    hosts: [createReferenceRuntimeLocalHost(), createReferenceInContainerHost()],
  });
});

When(
  "the trust-boundary component-host conformance suite compares the certified hosts",
  () => {
    assert.ok(world.crossHostReport, "cross-host conformance must have run");
  },
);

Then("the cross-host trust-boundary report passes every membrane assertion", () => {
  const report = world.crossHostReport;
  assert.ok(report);
  assert.equal(report.schema, "@hobo/conformance/component-host/v1");
  assert.equal(report.status, "pass");
  assert.ok(
    Object.values(report.crossHostAssertions).every((status) => status === "pass"),
    `all cross-host assertions pass: ${JSON.stringify(report.crossHostAssertions)}`,
  );
  assert.deepEqual(
    report.hosts.map((host: { kind: string; status: string }) => [host.kind, host.status]),
    [
      ["runtime-local", "pass"],
      ["wasm-in-container", "pass"],
    ],
  );
});

Then("the trust-boundary report declares its non-covered divergences", () => {
  assert.deepEqual(world.crossHostReport?.nonCoveredDivergences, [
    "wall-clock scheduling jitter",
    "host-specific partial-failure timing",
  ]);
});

// --- Scenario: Drifted host version is rejected before planning completes ----

Given(
  "a runtime-local component host that drifted to version {string}",
  (version: string) => {
    world.driftedHost = createReferenceRuntimeLocalHost({ version });
  },
);

When(
  "trust-boundary component-host planning checks the drifted host against the manifest pin",
  () => {
    world.planningError = undefined;
    try {
      planComponentHost(createReferenceComponentHostManifest(), world.driftedHost);
    } catch (error) {
      world.planningError = error;
    }
  },
);

Then(
  "trust-boundary planning fails closed with code {string}",
  (code: string) => {
    const error = world.planningError;
    assert.ok(error instanceof ComponentHostPlanningError, "planning must throw the typed error");
    // SAFETY: assertion to `r as ComponentHostPlanningError & { code: string }).co` is required at this boundary.
    assert.equal((error as ComponentHostPlanningError & { code: string }).code, code);
    assert.deepEqual(
      // SAFETY: assertion to `r as ComponentHostPlanningError & { expectedVersions: string[] }).ex` is required at this boundary.
      (error as ComponentHostPlanningError & { expectedVersions: string[] }).expectedVersions,
      ["wasmtime/46.0.1"],
      "the error names the manifest-pinned versions",
    );
  },
);
