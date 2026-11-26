import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createCrossParadigmPlan,
  createExternalDependencyPlan,
  createPortablePlan,
  createProviderOptionPlan,
  createRawDialectPlan,
  createStaticKeyPlan,
  createGateInputFromPlan,
  realizeWithPortabilityReport,
  validatePortabilityReport
} from "../src/portability-report-contract.js";

test("portable provider realization emits an empty non-portable surface attached to deployment.Planned", () => {
  const realized = realizeWithPortabilityReport(createPortablePlan());

  assert.deepEqual(realized.deploymentPlanned.portabilityReport.entries, []);
  assert.deepEqual(realized.deploymentPlanned.portabilityReport.zeroSecretExceptions, []);
  assert.deepEqual(
    createGateInputFromPlan(realized.deploymentPlanned).nonPortableSurface,
    realized.deploymentPlanned.portabilityReport
  );
});

test("provider-specific .with options are emitted with target-scoped severity", () => {
  const realized = realizeWithPortabilityReport(createProviderOptionPlan());
  const validation = validatePortabilityReport(realized);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.deepEqual(realized.deploymentPlanned.portabilityReport.entries, [
    {
      id: "assets.provider-option.aws.r2-compatible-mode",
      category: "provider-option",
      severity: "target-scoped",
      resourceId: "assets",
      provider: "aws",
      path: "resources.assets.with.aws.r2-compatible-mode",
      detail: "Provider-specific .with option requires target provider support.",
      gateEffect: "target-provider-must-satisfy"
    }
  ]);
});

test("raw driver dialect leaks are blocking report entries", () => {
  const realized = realizeWithPortabilityReport(createRawDialectPlan());
  const validation = validatePortabilityReport(realized);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(realized.deploymentPlanned.portabilityReport.entries[0].category, "raw-dialect-leak");
  assert.equal(realized.deploymentPlanned.portabilityReport.entries[0].severity, "blocking");
});

test("static keys and external or adopted dependencies are also zero-secret audit exceptions", () => {
  const staticKey = realizeWithPortabilityReport(createStaticKeyPlan());
  const external = realizeWithPortabilityReport(createExternalDependencyPlan());

  assert.equal(validatePortabilityReport(staticKey).ok, true);
  assert.equal(validatePortabilityReport(external).ok, true);
  assert.deepEqual(
    staticKey.deploymentPlanned.portabilityReport.zeroSecretExceptions.map((entry) => entry.category),
    ["static-key"]
  );
  assert.deepEqual(
    external.deploymentPlanned.portabilityReport.zeroSecretExceptions.map((entry) => entry.category),
    ["external-dependency", "adopted-dependency"]
  );
});

test("provider under-reporting is caught before a gate consumes the plan", () => {
  const realized = realizeWithPortabilityReport(createProviderOptionPlan(), {
    omitCategories: ["provider-option"]
  });
  const validation = validatePortabilityReport(realized);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /unreported provider-option marker/);
});

test("cross-paradigm features cannot be scored as portable", () => {
  const realized = realizeWithPortabilityReport(createCrossParadigmPlan());
  realized.deploymentPlanned.portabilityReport.entries[0].severity = "portable";

  const validation = validatePortabilityReport(realized);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /cross-paradigm.*cannot be portable/);
});

test("external dependencies cannot escape both PortabilityReport and zero-secret audit", () => {
  const realized = realizeWithPortabilityReport(createExternalDependencyPlan(), {
    omitCategories: ["external-dependency"],
    omitZeroSecretCategories: ["adopted-dependency"]
  });
  const validation = validatePortabilityReport(realized);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /unreported external-dependency marker/);
  assert.match(validation.errors.join("\n"), /adopted-dependency marker missing zero-secret audit exception/);
});
