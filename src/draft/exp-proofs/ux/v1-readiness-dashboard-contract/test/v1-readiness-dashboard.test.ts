import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_DASHBOARD_FIELDS,
  assertV1ReadinessDashboard,
  v1ReadinessDashboard,
  validateV1ReadinessDashboard
} from "../src/v1-readiness-dashboard.js";

test("dashboard fields cover cutline, blockers, milestone health, evidence links, risks, owners, and last verified date", () => {
  const result = validateV1ReadinessDashboard(v1ReadinessDashboard);
  const fieldNames = new Set(v1ReadinessDashboard.fields.map((field) => field.name));

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual([...fieldNames].sort(), [...REQUIRED_DASHBOARD_FIELDS].sort());
});

test("each field has a source of truth and update cadence", () => {
  for (const field of v1ReadinessDashboard.fields) {
    assert.ok(field.sourceOfTruth, `${field.name} missing source of truth`);
    assert.ok(field.updateCadence, `${field.name} missing update cadence`);
    assert.ok(field.ownerProject, `${field.name} missing owner project`);
  }
});

test("missing evidence is explicit and cannot render as green", () => {
  const invalid = structuredClone(v1ReadinessDashboard);
  invalid.fields.find((field) => field.name === "evidenceLinks")!.emptyState = {
    label: "Ready",
    color: "green",
    launchMeaning: "No evidence attached yet"
  };

  const result = validateV1ReadinessDashboard(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /missing evidence cannot render as green/);
  assert.throws(() => assertV1ReadinessDashboard(invalid), /v1 readiness dashboard contract invalid/);
});

test("dashboard aggregates release evidence and rejects feature implementation scope", () => {
  assert.equal(v1ReadinessDashboard.scope.kind, "release-evidence-aggregate");
  assert.equal(v1ReadinessDashboard.scope.implementsFeatureWork, false);
  assert.ok(v1ReadinessDashboard.scope.scopeOut.includes("feature-implementation"));
  assert.ok(v1ReadinessDashboard.scope.scopeOut.includes("runtime-dashboard-ui"));
});
