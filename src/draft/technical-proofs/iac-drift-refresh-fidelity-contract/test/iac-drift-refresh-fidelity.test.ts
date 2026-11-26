import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createDriftFidelityFixture,
  createRefreshProvider,
  evaluateRefreshReport,
  reconcileDriftReport,
  runRefreshFidelityConformance,
} from "../src/iac-drift-refresh-fidelity.js";

describe("IaC refresh drift fidelity", () => {
  it("reports out-of-band update, delete, and create drift exactly", () => {
    const fixture = createDriftFidelityFixture();
    const observed = structuredClone(fixture.observed);

    observed.resources.api.spec.image = "api:v2";
    delete observed.resources.worker;
    observed.resources["debug-shell"] = {
      id: "debug-shell",
      kind: "managed",
      stackKey: fixture.stackKey,
      spec: { image: "debug:v1" },
      provider: { backend: "iac-pulumi", provider: "aws" },
      observed: { urn: "urn:pulumi:debug-shell" },
    };

    const report = evaluateRefreshReport({ ...fixture, observed });

    assert.equal(report.drifted, true);
    assert.deepEqual(
      report.resources.map((resource) => ({
        resourceId: resource.resourceId,
        action: resource.action,
        reasons: resource.reasons,
      })),
      [
        { resourceId: "api", action: "update", reasons: ["spec-drift"] },
        { resourceId: "debug-shell", action: "delete-extra", reasons: ["extra-in-reality"] },
        { resourceId: "worker", action: "recreate", reasons: ["missing-in-reality"] },
      ],
    );
    assert.deepEqual(report.resources[0].changes[0], {
      path: "spec.image",
      desired: "api:v1",
      observed: "api:v2",
      reason: "spec-drift",
    });
  });

  it("ignores provider-normalized fields that would otherwise cause perpetual false drift", () => {
    const fixture = createDriftFidelityFixture();
    const observed = structuredClone(fixture.observed);

    observed.resources.api.spec.serverDefaultedSku = "provider-defaulted-standard";
    observed.resources.api.observed.revision = "rev-from-provider";

    const report = evaluateRefreshReport({ ...fixture, observed });

    assert.equal(report.drifted, false);
    assert.deepEqual(
      report.ignoredNormalized.map((entry) => entry.path),
      ["api.observed.revision", "api.spec.serverDefaultedSku"],
    );
  });

  it("converges once after drift and makes the second reconcile pass a no-op", () => {
    const fixture = createDriftFidelityFixture();
    const observed = structuredClone(fixture.observed);

    observed.resources.api.spec.image = "api:v2";
    delete observed.resources.worker;
    observed.resources["debug-shell"] = {
      id: "debug-shell",
      kind: "managed",
      stackKey: fixture.stackKey,
      spec: { image: "debug:v1" },
      provider: { backend: "iac-opentofu", provider: "aws" },
      observed: { urn: "urn:tofu:debug-shell" },
    };

    const report = evaluateRefreshReport({ ...fixture, observed });
    const firstPass = reconcileDriftReport({ ...fixture, observed, report });
    const secondReport = evaluateRefreshReport({ ...fixture, observed: firstPass.observed });
    const secondPass = reconcileDriftReport({ ...fixture, observed: firstPass.observed, report: secondReport });

    assert.deepEqual(firstPass.actions.map((action) => action.action), [
      "update:api",
      "delete-extra:debug-shell",
      "recreate:worker",
    ]);
    assert.equal(secondReport.drifted, false);
    assert.deepEqual(secondPass.actions, []);
  });

  it("records adopted resource drift without destroying or recreating the adopted node", () => {
    const fixture = createDriftFidelityFixture();
    const observed = structuredClone(fixture.observed);

    observed.resources["legacy-db"].spec.endpoint = "postgres://moved.internal:5432/shop";

    const report = evaluateRefreshReport({ ...fixture, observed });
    const reconciled = reconcileDriftReport({ ...fixture, observed, report });

    assert.deepEqual(report.resources, [
      {
        resourceId: "legacy-db",
        kind: "adopted",
        stackKey: "tenant-a/prod/legacy-db",
        mode: "detect-only",
        action: "record-drift",
        reasons: ["spec-drift"],
        changes: [
          {
            path: "spec.endpoint",
            desired: "postgres://legacy.internal:5432/shop",
            observed: "postgres://moved.internal:5432/shop",
            reason: "spec-drift",
          },
        ],
      },
    ]);
    assert.deepEqual(reconciled.actions, [
      { action: "record-drift", resourceId: "legacy-db", mode: "detect-only" },
    ]);
    assert.equal(
      reconciled.observed.resources["legacy-db"].spec.endpoint,
      "postgres://moved.internal:5432/shop",
    );
  });

  it("attributes co-provisioned child drift without dirtying the parent", () => {
    const fixture = createDriftFidelityFixture();
    const observed = structuredClone(fixture.observed);

    observed.resources["api-log-group"].spec.retentionDays = 14;

    const report = evaluateRefreshReport({ ...fixture, observed });

    assert.deepEqual(
      report.resources.map((resource) => ({
        resourceId: resource.resourceId,
        parentId: resource.parentId,
        action: resource.action,
      })),
      [{ resourceId: "api-log-group", parentId: "api", action: "update" }],
    );
  });

  it("requires camp-tagged conformance and catches flaky refresh misses", async () => {
    const fixture = createDriftFidelityFixture();
    const observed = structuredClone(fixture.observed);

    observed.resources.api.spec.image = "api:v2";

    const passing = await runRefreshFidelityConformance(
      createRefreshProvider({ fixture, observed }),
      { fixture, observed, attempts: 3 },
    );

    assert.equal(passing.status, "pass");
    assert.deepEqual(
      passing.checks.map((check) => ({ id: check.id, tag: check.tag })),
      [{ id: "iac-drift.camp.refresh-fidelity", tag: "camp" }],
    );

    const goodReport = evaluateRefreshReport({ ...fixture, observed });
    const noDriftReport = evaluateRefreshReport({ ...fixture, observed: fixture.observed });
    const flaky = await runRefreshFidelityConformance(
      createRefreshProvider({
        fixture,
        observed,
        reports: [goodReport, noDriftReport, goodReport],
      }),
      { fixture, observed, attempts: 3 },
    );

    assert.equal(flaky.status, "fail");
    assert.equal(flaky.failures[0].code, "refresh-intermittent-miss");
    assert.match(flaky.failures[0].message, /api/);
  });
});
