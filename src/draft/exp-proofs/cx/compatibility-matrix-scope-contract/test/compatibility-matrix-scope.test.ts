import assert from "node:assert/strict";
import { test } from "vitest";

import {
  COMPATIBILITY_MATRIX_SCOPE,
  REQUIRED_SCOPE_SECTIONS,
  validateCompatibilityMatrixScope,
} from "../src/compatibility-matrix-scope.js";

test("M0 scope record names goal, personas, boundaries, M1 evidence, and follow-up gate", () => {
  const result = validateCompatibilityMatrixScope(COMPATIBILITY_MATRIX_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(COMPATIBILITY_MATRIX_SCOPE.issue, "HOBO-432");
  assert.equal(COMPATIBILITY_MATRIX_SCOPE.phase, "M0");
  assert.deepEqual(REQUIRED_SCOPE_SECTIONS, [
    "goal",
    "primaryPersonas",
    "scopeIn",
    "scopeOut",
    "owningBoundaries",
    "m1Evidence",
    "followUpGate",
  ]);
  for (const section of REQUIRED_SCOPE_SECTIONS) {
    assert.ok(COMPATIBILITY_MATRIX_SCOPE[section], `${section} must be defined`);
  }
});

test("personas and owner boundaries cover product, DX, support, release, security, and privacy needs", () => {
  assert.deepEqual(
    COMPATIBILITY_MATRIX_SCOPE.primaryPersonas.map((persona) => persona.id),
    [
      "persona.app-developer",
      "persona.platform-engineer",
      "persona.support-operator",
      "persona.release-owner",
    ],
  );

  assert.deepEqual(
    COMPATIBILITY_MATRIX_SCOPE.owningBoundaries.map((boundary) => boundary.id),
    [
      "boundary.product",
      "boundary.ux",
      "boundary.dx-cli",
      "boundary.support-release",
      "boundary.security-privacy",
    ],
  );
});

test("validation rejects scope creep and proofless follow-up work", () => {
  // SAFETY: `const invalid = structuredClone(COMPATIBILITY_MATRIX_SCOPE) as typeof COMPATIBIL` is required at this I/O or test boundary.
  const invalid = structuredClone(COMPATIBILITY_MATRIX_SCOPE) as typeof COMPATIBILITY_MATRIX_SCOPE & {
    scopeIn: Array<{ id: string; summary: string; workKind?: string }>;
  };

  invalid.scopeIn.push({
    id: "scope.browser-grid-runtime",
    summary: "Build the live browser grid during M0.",
    workKind: "live-browser-grid",
  });
  invalid.scopeOut = invalid.scopeOut.filter((item) => item.id !== "scope-out.browser-grid");
  invalid.followUpGate = "";

  const result = validateCompatibilityMatrixScope(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /live-browser-grid is out of scope/);
  assert.match(result.errors.join("\n"), /scope-out\.browser-grid is required/);
  assert.match(result.errors.join("\n"), /followUpGate must be defined/);
});
