import assert from "node:assert/strict";
import { test } from "vitest";

import {
  HostPlanningError,
  createHostManifest,
  doctorHostCompatibility,
  planComponentHostDeployment,
  planHostUpgrade
} from "../src/host-version-upgrade.js";

const CURRENT_HOST = {
  kind: "component-host",
  name: "camp-wasmtime",
  version: "46.0.1",
  behaviorProfileHash: "sha256:host-behavior-v46"
};

const TARGET_HOST = {
  kind: "component-host",
  name: "camp-wasmtime",
  version: "47.0.0",
  behaviorProfileHash: "sha256:host-behavior-v47"
};

function baseManifest() {
  return createHostManifest({
    bindle: "bindle:inventory-api@1.3.0",
    component: "inventory-api",
    componentHost: CURRENT_HOST
  });
}

test("pinned host vN fails planning on incompatible Camp host with a precise reason", () => {
  const manifest = baseManifest();

  assert.throws(
    () =>
      planComponentHostDeployment({
        manifest,
        campHost: TARGET_HOST
      }),
    (error) =>
      error instanceof HostPlanningError &&
      error.code === "component_host.host-version-incompatible" &&
      error.reason === "manifest-host-pin-does-not-match-camp-host" &&
      error.expected.version === "46.0.1" &&
      error.actual.version === "47.0.0" &&
      error.phase === "planning"
  );
});

test("semantics-changing host upgrade runs a verified upcaster and repins manifest IR", () => {
  const manifest = baseManifest();

  const upgrade = planHostUpgrade({
    manifest,
    targetHost: TARGET_HOST,
    requestedBy: "operator:platform",
    conformanceReports: [
      { host: TARGET_HOST, status: "pass", suite: "component-host-portability/v1" }
    ],
    upcasters: [
      {
        from: CURRENT_HOST,
        to: TARGET_HOST,
        id: "upcaster:camp-wasmtime-46-to-47",
        verified: true,
        apply(inputManifest) {
          return {
            ...inputManifest,
            bindle: "bindle:inventory-api@1.4.0",
            compatibilityNotes: ["wasmtime 47 trap-order semantics normalized"]
          };
        }
      }
    ]
  });

  assert.equal(upgrade.ok, true);
  assert.equal(upgrade.decision, "upgrade-host-with-upcaster");
  assert.equal(upgrade.manifest.componentHost.version, "47.0.0");
  assert.equal(upgrade.manifest.bindle, "bindle:inventory-api@1.4.0");
  assert.equal(manifest.componentHost.version, "46.0.1");
  assert.equal(
    upgrade.events.some((event) => event.type === "componentHost.UpcasterApplied"),
    true
  );
  assert.deepEqual(upgrade.appliedUpcasters, ["upcaster:camp-wasmtime-46-to-47"]);
});

test("semantics-changing host upgrade without an upcaster is blocked without rewriting manifest IR", () => {
  const manifest = baseManifest();

  assert.throws(
    () =>
      planHostUpgrade({
        manifest,
        targetHost: TARGET_HOST,
        requestedBy: "operator:platform",
        conformanceReports: [
          { host: TARGET_HOST, status: "pass", suite: "component-host-portability/v1" }
        ],
        upcasters: []
      }),
    (error) =>
      error instanceof HostPlanningError &&
      error.code === "component_host.upcaster-required" &&
      error.reason === "semantics-changing-host-upgrade-has-no-verified-upcaster" &&
      error.phase === "host-upgrade" &&
      error.expected.version === "46.0.1" &&
      error.actual.version === "47.0.0"
  );
  assert.equal(manifest.componentHost.version, "46.0.1");
});

test("ungated host upgrade is rejected even when the target host passes conformance", () => {
  const manifest = baseManifest();

  assert.throws(
    () =>
      planHostUpgrade({
        manifest,
        targetHost: TARGET_HOST,
        conformanceReports: [
          { host: TARGET_HOST, status: "pass", suite: "component-host-portability/v1" }
        ],
        upcasters: [
          {
            from: CURRENT_HOST,
            to: TARGET_HOST,
            id: "upcaster:camp-wasmtime-46-to-47",
            verified: true,
            apply(inputManifest) {
              return inputManifest;
            }
          }
        ]
      }),
    (error) =>
      error instanceof HostPlanningError &&
      error.code === "component_host.upgrade-gate-required" &&
      error.reason === "host-upgrade-request-missing-operator-gate"
  );
  assert.equal(manifest.componentHost.version, "46.0.1");
});

test("hobo doctor surfaces host lock-in and upgrade readiness", () => {
  const manifest = createHostManifest({
    bindle: "bindle:billing-api@2.0.0",
    component: "billing-api",
    componentHost: CURRENT_HOST,
    hostOptions: {
      "camp-wasmtime.trap-order": "legacy"
    }
  });

  const report = doctorHostCompatibility({
    manifest,
    registeredHosts: [
      {
        host: CURRENT_HOST,
        conformance: { status: "pass", suite: "component-host-portability/v1" }
      },
      {
        host: TARGET_HOST,
        conformance: { status: "pass", suite: "component-host-portability/v1" },
        upcaster: {
          id: "upcaster:camp-wasmtime-46-to-47",
          verified: true
        }
      },
      {
        host: { ...TARGET_HOST, version: "48.0.0", behaviorProfileHash: "sha256:v48" },
        conformance: { status: "pass", suite: "component-host-portability/v1" }
      }
    ]
  });

  assert.deepEqual(report.currentPin, {
    kind: "component-host",
    name: "camp-wasmtime",
    version: "46.0.1"
  });
  assert.deepEqual(report.lockIn, [
    {
      code: "component_host.host-lock-in",
      option: "camp-wasmtime.trap-order",
      reason: "manifest uses host-specific option"
    }
  ]);
  assert.deepEqual(
    report.upgradeReadiness.map((entry) => [entry.to.version, entry.status, entry.reason]),
    [
      ["47.0.0", "ready-with-upcaster", "verified upcaster available"],
      ["48.0.0", "blocked", "semantics-changing host upgrade requires verified upcaster"]
    ]
  );
});

test("upgrade target without passing conformance is rejected before upcaster selection", () => {
  const manifest = baseManifest();

  assert.throws(
    () =>
      planHostUpgrade({
        manifest,
        targetHost: TARGET_HOST,
        requestedBy: "operator:platform",
        conformanceReports: [
          { host: TARGET_HOST, status: "fail", suite: "component-host-portability/v1" }
        ],
        upcasters: [
          {
            from: CURRENT_HOST,
            to: TARGET_HOST,
            id: "upcaster:camp-wasmtime-46-to-47",
            verified: true,
            apply(inputManifest) {
              return inputManifest;
            }
          }
        ]
      }),
    (error) =>
      error instanceof HostPlanningError &&
      error.code === "component_host.conformance-required" &&
      error.reason === "target-host-has-no-passing-conformance-report"
  );
});
