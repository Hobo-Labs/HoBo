import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  ACCESSIBILITY_USABILITY_BASELINE,
  REQUIRED_CHECKS,
  REQUIRED_SURFACES,
  classifyAccessibilityFinding,
  routeAccessibilityFinding,
  validateAccessibilityException,
  validateAccessibilityUsabilityBaseline,
} from "../src/accessibility-usability-launch-baseline.mjs";

describe("accessibility and usability launch baseline", () => {
  it("validates the HOBO-505 M0 baseline record", () => {
    const result = validateAccessibilityUsabilityBaseline(ACCESSIBILITY_USABILITY_BASELINE);

    assert.deepEqual(result, { ok: true, errors: [] });
    assert.deepEqual(
      ACCESSIBILITY_USABILITY_BASELINE.surfaces.map((surface) => surface.id),
      REQUIRED_SURFACES,
    );
    assert.deepEqual(
      ACCESSIBILITY_USABILITY_BASELINE.requiredChecks.map((check) => check.id),
      REQUIRED_CHECKS,
    );
  });

  it("rejects a generic UX gate that hides required accessibility checks", () => {
    const incomplete = {
      ...ACCESSIBILITY_USABILITY_BASELINE,
      requiredChecks: ACCESSIBILITY_USABILITY_BASELINE.requiredChecks.filter(
        (check) => check.id !== "screen-reader-smoke",
      ),
    };

    const result = validateAccessibilityUsabilityBaseline(incomplete);

    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("required checks are incomplete or out of order"));
  });

  it("keeps launch blockers non-waivable and gate overrides forbidden", () => {
    const blocker = classifyAccessibilityFinding({
      check: "keyboard-only-path",
      surface: "workspace-onboarding",
      requiredGateFailing: true,
      customerImpact: true,
    });

    assert.equal(blocker.decisionClass, "launch-blocker");
    assert.equal(blocker.mayShip, false);

    const exception = validateAccessibilityException({
      decisionClass: "launch-blocker",
      approverRole: "release-owner",
      gateOverrides: ["manual-assistive-tech", "ci", "security", "review", "contract-tests"],
      evidence: {
        findingRecord: "A11Y-1",
        impact: "Keyboard-only first run cannot complete.",
        mitigation: "Documented limitation.",
        expiry: "2026-07-15",
      },
    });

    assert.equal(exception.ok, false);
    assert.ok(exception.errors.includes("launch blockers cannot be waived by exception"));
    assert.ok(exception.errors.includes("manual-assistive-tech gate cannot be overridden"));
    assert.ok(exception.errors.includes("ci gate cannot be overridden"));
    assert.ok(exception.errors.includes("security gate cannot be overridden"));
    assert.ok(exception.errors.includes("review gate cannot be overridden"));
    assert.ok(exception.errors.includes("contract-tests gate cannot be overridden"));
  });

  it("routes accessibility findings to the owning launch surface instead of a catch-all bucket", () => {
    assert.equal(routeAccessibilityFinding({ surface: "docs", check: "semantic-labels" }), "V1 Release Notes & Upgrade Guide");
    assert.equal(routeAccessibilityFinding({ surface: "admin-support", check: "copy-clarity" }), "V1 Launch Support Desk & Escalation");
    assert.equal(routeAccessibilityFinding({ surface: "deployment-dashboard", check: "focus-order" }), "Deployment Dashboard & Topology Explorer");
    assert.equal(routeAccessibilityFinding({ surface: "unknown", check: "contrast" }), "V1 Release Program & Cutline");
  });

  it("rejects scope creep into product UI implementation or final audit output", () => {
    const scopedTooBroadly = {
      ...ACCESSIBILITY_USABILITY_BASELINE,
      scopeIn: [
        ...ACCESSIBILITY_USABILITY_BASELINE.scopeIn,
        "Build production dashboard accessibility fixes.",
      ],
    };

    const result = validateAccessibilityUsabilityBaseline(scopedTooBroadly);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.startsWith("scope creep:")));
  });
});
