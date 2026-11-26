import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CUSTOMER_ONBOARDING_SCRIPT,
  canUseCustomerOnboardingScript,
  classifyPilotNote,
  validateCustomerOnboardingScript,
} from "../src/customer-onboarding-script.ts";

test("accepted script record covers the HOBO-487 goal and personas", () => {
  const result = validateCustomerOnboardingScript(CUSTOMER_ONBOARDING_SCRIPT);

  assert.deepEqual(result.errors, []);
  assert.equal(CUSTOMER_ONBOARDING_SCRIPT.issue, "HOBO-487");
  assert.equal(CUSTOMER_ONBOARDING_SCRIPT.phase, "M0");
  assert.match(CUSTOMER_ONBOARDING_SCRIPT.goal, /first-customer onboarding/i);
  assert.deepEqual(
    CUSTOMER_ONBOARDING_SCRIPT.personas.map((persona) => persona.role),
    [
      "pilot customer champion",
      "customer success lead",
      "support engineer",
      "release owner",
    ],
  );
});

test("script covers invite through feedback capture", () => {
  assert.deepEqual(
    CUSTOMER_ONBOARDING_SCRIPT.scriptStages.map((stage) => stage.id),
    [
      "invite",
      "workspace-setup",
      "project-choice",
      "first-deploy",
      "failure-recovery",
      "support-handoff",
      "feedback-capture",
    ],
  );
  assert.equal(
    CUSTOMER_ONBOARDING_SCRIPT.scriptStages.every(
      (stage) => stage.owner && stage.prompt && stage.expectedEvidence && stage.proofMode,
    ),
    true,
  );
});

test("success criteria match acceptance categories", () => {
  assert.deepEqual(
    CUSTOMER_ONBOARDING_SCRIPT.successCriteria.map((criterion) => criterion.id),
    [
      "time-to-first-success",
      "blocker-categories",
      "handoff-quality",
      "unresolved-risk",
    ],
  );
});

test("pilot notes route to owning launch surfaces", () => {
  assert.equal(classifyPilotNote({ category: "support-gap" }), "Support Workflow");
  assert.equal(classifyPilotNote({ category: "product-ux" }), "Workspace & Onboarding UX");
  assert.equal(classifyPilotNote({ category: "docs-gap" }), "V1 Release Notes & Upgrade Guide");
  assert.equal(classifyPilotNote({ category: "engineering-gap" }), "Owning engineering project");
  assert.equal(classifyPilotNote({ category: "go-no-go-risk" }), "V1 Release Program & Cutline");
});

test("future customer pilot usage is gated by accepted evidence and consent", () => {
  assert.equal(
    canUseCustomerOnboardingScript({
      m0Accepted: false,
      scriptReviewed: true,
      supportOwnerAssigned: true,
      customerConsentCaptured: true,
    }),
    false,
  );
  assert.equal(
    canUseCustomerOnboardingScript({
      m0Accepted: true,
      scriptReviewed: true,
      supportOwnerAssigned: true,
      customerConsentCaptured: true,
    }),
    true,
  );
});

test("scope validation rejects automation, live-customer-data, and support-tool creep", () => {
  const result = validateCustomerOnboardingScript({
    ...CUSTOMER_ONBOARDING_SCRIPT,
    scopeIn: [
      ...CUSTOMER_ONBOARDING_SCRIPT.scopeIn,
      "Automate onboarding inside the product and collect live customer data for support tooling.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("stage validation requires owner, proof mode, evidence, and source", () => {
  const result = validateCustomerOnboardingScript({
    ...CUSTOMER_ONBOARDING_SCRIPT,
    scriptStages: [
      ...CUSTOMER_ONBOARDING_SCRIPT.scriptStages,
      {
        id: "unsupported-stage",
        prompt: "Do a hidden onboarding step.",
        owner: "",
        expectedEvidence: "",
        proofMode: "unsupported",
        source: "",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /owner/i);
  assert.match(result.errors.join("\n"), /proof mode/i);
  assert.match(result.errors.join("\n"), /source/i);
});
