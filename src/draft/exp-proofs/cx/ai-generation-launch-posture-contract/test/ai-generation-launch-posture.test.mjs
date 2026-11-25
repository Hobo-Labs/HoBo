import assert from "node:assert/strict";
import { test } from "vitest";

import {
  AI_GENERATION_LAUNCH_POSTURE,
  REQUIRED_FINDING_ROUTES,
  REQUIRED_PROHIBITED_USE_CASES,
  REQUIRED_PUBLIC_CLAIM_EVIDENCE,
  REQUIRED_SAFETY_CONTROLS,
  REQUIRED_SUPPORTED_INPUTS,
  classifyLaunchGap,
  rejectScopeCreep,
  reviewPublicClaim,
  routeGenerationFinding,
  validateLaunchPosture,
} from "../src/ai-generation-launch-posture.mjs";

test("M0 launch posture defines supported inputs, prohibited uses, controls, and disclaimers", () => {
  const result = validateLaunchPosture(AI_GENERATION_LAUNCH_POSTURE);

  assert.deepEqual(result.errors, []);
  assert.equal(AI_GENERATION_LAUNCH_POSTURE.issue, "HOBO-510");
  assert.equal(AI_GENERATION_LAUNCH_POSTURE.phase, "M0");
  assert.deepEqual(
    AI_GENERATION_LAUNCH_POSTURE.supportedInputs.map((input) => input.id),
    REQUIRED_SUPPORTED_INPUTS,
  );
  assert.deepEqual(
    AI_GENERATION_LAUNCH_POSTURE.prohibitedUseCases.map((useCase) => useCase.id),
    REQUIRED_PROHIBITED_USE_CASES,
  );
  assert.deepEqual(
    AI_GENERATION_LAUNCH_POSTURE.safetyControls.map((control) => control.id),
    REQUIRED_SAFETY_CONTROLS,
  );
});

test("each supported input names a safety boundary, customer-facing limit, and architecture evidence", () => {
  for (const input of AI_GENERATION_LAUNCH_POSTURE.supportedInputs) {
    assert.ok(input.safetyBoundary, `${input.id} missing safetyBoundary`);
    assert.ok(input.customerFacingLimit, `${input.id} missing customerFacingLimit`);
    assert.match(input.architectureEvidence, /^docs\/design\//);
  }
});

test("finding routes cover abuse, unsafe output, leakage, provider failure, and generated vulnerabilities", () => {
  assert.deepEqual(
    AI_GENERATION_LAUNCH_POSTURE.findingRoutes.map((route) => route.id),
    REQUIRED_FINDING_ROUTES,
  );

  for (const routeId of REQUIRED_FINDING_ROUTES) {
    const result = routeGenerationFinding(routeId);

    assert.equal(result.ok, true);
    assert.equal(result.requiresLaunchDisposition, true);
    for (const lane of ["securityVerification", "legalPrivacy", "support", "releaseCutline"]) {
      assert.ok(result.route[lane], `${routeId} missing ${lane}`);
    }
  }
});

test("beta and GA postures distinguish allowed claims, required evidence, and launch blockers", () => {
  for (const phase of ["beta", "ga"]) {
    const posture = AI_GENERATION_LAUNCH_POSTURE.releasePosture[phase];

    assert.ok(posture.allowedClaims.length > 0, `${phase} allowedClaims missing`);
    assert.ok(posture.requiredEvidence.length > 0, `${phase} requiredEvidence missing`);
    assert.ok(posture.blockers.length > 0, `${phase} blockers missing`);
  }

  assert.ok(AI_GENERATION_LAUNCH_POSTURE.releasePosture.beta.allowedClaims.some((claim) => /fixture-backed|manually reviewed/i.test(claim)));
  assert.ok(AI_GENERATION_LAUNCH_POSTURE.releasePosture.ga.requiredEvidence.includes("red-team-regression-evidence"));
});

test("public claims are reviewable only when exact approved wording has evidence and owners", () => {
  for (const claim of AI_GENERATION_LAUNCH_POSTURE.publicClaims) {
    for (const field of REQUIRED_PUBLIC_CLAIM_EVIDENCE) {
      assert.ok(claim[field], `${claim.id} missing ${field}`);
    }

    const result = reviewPublicClaim(claim.approvedText);
    assert.deepEqual(result.errors, []);
  }
});

test("adversarial public claims cannot overstate generated safety or compliance", () => {
  const unsafeClaim = reviewPublicClaim("HoBo generated code is fully safe, certified compliant, and has no hallucinations.");

  assert.equal(unsafeClaim.ok, false);
  assert.match(unsafeClaim.errors.join("\n"), /overstates safety/);
  assert.match(unsafeClaim.errors.join("\n"), /approved reviewed claim/);
});

test("launch gaps must be blockers, known limitations, or post-v1 follow-ups with required metadata", () => {
  assert.deepEqual(classifyLaunchGap({ id: "gap.guardrail", disposition: "launch-blocker" }), {
    ok: true,
    disposition: "launch-blocker",
  });
  assert.deepEqual(
    classifyLaunchGap({
      id: "gap.beta-redteam",
      disposition: "known-limitation",
      customerFacingText: "Beta red-team coverage is seeded and expands before GA.",
    }),
    {
      ok: true,
      disposition: "known-limitation",
    },
  );
  assert.deepEqual(
    classifyLaunchGap({
      id: "gap.watermarking",
      disposition: "post-v1-follow-up",
      followUpOwner: "Threat Model & Security Review",
    }),
    {
      ok: true,
      disposition: "post-v1-follow-up",
    },
  );

  const missingText = classifyLaunchGap({ id: "gap.no-message", disposition: "known-limitation" });
  assert.equal(missingText.ok, false);
  assert.match(missingText.errors.join("\n"), /customerFacingText/);
});

test("scope guard rejects expanding this issue into AI-safety platform implementation", () => {
  const result = rejectScopeCreep([
    "Implement a guardrail engine",
    "Wire a live model provider",
    "Draft legal terms for responsible-AI certification",
    "Build the generation runtime and Registry implementation",
  ]);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /guardrail engine/);
  assert.match(result.errors.join("\n"), /live model provider/);
  assert.match(result.errors.join("\n"), /legal terms/);
  assert.match(result.errors.join("\n"), /generation runtime/);
  assert.match(result.errors.join("\n"), /registry implementation/);
});

test("validation fails closed when a required route or control is removed", () => {
  const invalid = structuredClone(AI_GENERATION_LAUNCH_POSTURE);
  invalid.safetyControls = invalid.safetyControls.filter((control) => control.id !== "no-egress-validation-sandbox");
  invalid.findingRoutes = invalid.findingRoutes.filter((route) => route.id !== "data-leakage-or-residency-risk");
  invalid.publicClaims[0] = {
    ...invalid.publicClaims[0],
    proofCitation: "",
  };

  const result = validateLaunchPosture(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /safetyControls missing no-egress-validation-sandbox/);
  assert.match(result.errors.join("\n"), /findingRoutes missing data-leakage-or-residency-risk/);
  assert.match(result.errors.join("\n"), /contract-first-generation missing proofCitation/);
});
