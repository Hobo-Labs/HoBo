import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_LAUNCH_PERSONAS,
  evaluateJourneyEvidence,
  launchE2ePersonaMatrix,
  validateLaunchE2ePersonaMatrix,
} from "../src/e2e-persona-matrix.mjs";

test("matrix covers every launch persona and is owned by HOBO-500", () => {
  const result = validateLaunchE2ePersonaMatrix(launchE2ePersonaMatrix);

  assert.deepEqual(result.errors, []);
  assert.equal(launchE2ePersonaMatrix.issue, "HOBO-500");
  assert.equal(launchE2ePersonaMatrix.phase, "M0");
  assert.deepEqual(
    launchE2ePersonaMatrix.journeys.map((journey) => journey.persona),
    REQUIRED_LAUNCH_PERSONAS,
  );
});

test("each journey names environment, fixture data, mocked/live boundary, evidence, and pass/fail threshold", () => {
  for (const journey of launchE2ePersonaMatrix.journeys) {
    assert.ok(journey.environment, `${journey.id} missing environment`);
    assert.ok(journey.fixtureData.length > 0, `${journey.id} missing fixture data`);
    assert.ok(journey.boundary.mocked.length > 0 || journey.boundary.live.length > 0, `${journey.id} missing boundary`);
    assert.ok(journey.expectedEvidence.length > 0, `${journey.id} missing expected evidence`);
    assert.ok(journey.threshold.pass, `${journey.id} missing pass threshold`);
    assert.ok(journey.threshold.fail, `${journey.id} missing fail threshold`);
  }
});

test("flake policy and manual evidence fallback are explicit and cannot waive launch blockers", () => {
  const appDeveloper = launchE2ePersonaMatrix.journeys.find((journey) => journey.persona === "app developer");
  const flaky = evaluateJourneyEvidence(appDeveloper, {
    requiredEvidence: appDeveloper.expectedEvidence,
    status: "flaky",
    retryAttempts: 2,
    manualFallback: null,
    launchBlockerOpen: false,
  });

  assert.equal(flaky.ok, false);
  assert.match(flaky.errors.join("\n"), /flaky journey must route through quarantine/);

  const unsupportedManual = evaluateJourneyEvidence(appDeveloper, {
    requiredEvidence: appDeveloper.expectedEvidence,
    status: "manual-substitute",
    retryAttempts: 0,
    manualFallback: {
      reason: "browser lab unavailable",
      evidenceLink: "linear://evidence/browser-lab",
      approver: "release-owner",
    },
    launchBlockerOpen: true,
  });

  assert.equal(unsupportedManual.ok, false);
  assert.match(unsupportedManual.errors.join("\n"), /manual evidence cannot override launch blockers/);
});

test("manual fallback can cover a non-blocking evidence gap when the required audit fields exist", () => {
  const customerBuyer = launchE2ePersonaMatrix.journeys.find((journey) => journey.persona === "customer/buyer");
  const result = evaluateJourneyEvidence(customerBuyer, {
    requiredEvidence: customerBuyer.expectedEvidence,
    status: "manual-substitute",
    retryAttempts: 0,
    manualFallback: {
      reason: "recorded moderated beta walkthrough",
      evidenceLink: "linear://evidence/customer-buyer-walkthrough",
      approver: "release-owner",
    },
    launchBlockerOpen: false,
  });

  assert.deepEqual(result.errors, []);
});

test("journey evidence fails closed for failed or unknown statuses", () => {
  const securityReviewer = launchE2ePersonaMatrix.journeys.find((journey) => journey.persona === "security reviewer");
  const failed = evaluateJourneyEvidence(securityReviewer, {
    requiredEvidence: securityReviewer.expectedEvidence,
    status: "failed",
    retryAttempts: 0,
    launchBlockerOpen: false,
  });
  const unknown = evaluateJourneyEvidence(securityReviewer, {
    requiredEvidence: securityReviewer.expectedEvidence,
    status: "timed-out",
    retryAttempts: 0,
    launchBlockerOpen: false,
  });

  assert.equal(failed.ok, false);
  assert.match(failed.errors.join("\n"), /journey status failed cannot pass/);
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join("\n"), /unsupported journey evidence status/);
});

test("validation rejects a generic gate, missing persona journey, or full harness implementation scope creep", () => {
  const invalid = structuredClone(launchE2ePersonaMatrix);
  invalid.scopeBoundary.implementsFullE2eHarness = true;
  invalid.ownership.issueOwned = false;
  invalid.journeys = invalid.journeys.filter((journey) => journey.persona !== "security reviewer");
  invalid.journeys[0].threshold.fail = "";

  const result = validateLaunchE2ePersonaMatrix(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /missing persona journey: security reviewer/);
  assert.match(result.errors.join("\n"), /full e2e harness implementation is scope-out/);
  assert.match(result.errors.join("\n"), /generic gates are insufficient/);
  assert.match(result.errors.join("\n"), /missing fail threshold/);
});
