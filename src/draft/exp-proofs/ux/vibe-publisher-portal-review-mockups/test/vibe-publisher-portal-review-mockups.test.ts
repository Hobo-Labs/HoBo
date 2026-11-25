import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_PUBLISHER_PORTAL_ACCESSIBILITY_TOPICS,
  REQUIRED_PUBLISHER_PORTAL_FIXTURE_FIELDS,
  REQUIRED_PUBLISHER_PORTAL_PERSONAS,
  REQUIRED_PUBLISHER_PORTAL_PROOF_MODES,
  REQUIRED_PUBLISHER_PORTAL_QUICKSTART_FIXTURE_IDS,
  REQUIRED_PUBLISHER_PORTAL_QUICKSTART_PROOF_MODES,
  REQUIRED_PUBLISHER_PORTAL_SCENARIOS,
  REQUIRED_PUBLISHER_PORTAL_STATES,
  VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS,
  VibePublisherPortalReviewMockupsParseError,
  classifyPublisherPortalReviewMockupRequest,
  parseVibePublisherPortalReviewMockups,
  validateVibePublisherPortalReviewMockups,
} from "../src/vibe-publisher-portal-review-mockups.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("HOBO-548 proof pins issue, phase, package path, proof path, personas, and states", () => {
  const parsed = parseVibePublisherPortalReviewMockups(VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS);

  assert.equal(parsed.issue, "HOBO-548");
  assert.equal(parsed.phase, "M1");
  assert.equal(parsed.packagePath, "src/draft/exp-proofs/ux/vibe-publisher-portal-review-mockups");
  assert.equal(parsed.proofPath, "docs/design/proofs/vibe-publisher-portal-review-mockups/README.md");
  assert.deepEqual(parsed.personas, REQUIRED_PUBLISHER_PORTAL_PERSONAS);
  assert.deepEqual(
    parsed.mockups.map((mockup) => mockup.state),
    REQUIRED_PUBLISHER_PORTAL_STATES,
  );
});

test("mockups cover every publisher portal review persona with operating questions", () => {
  for (const persona of REQUIRED_PUBLISHER_PORTAL_PERSONAS) {
    const personaMockups = VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.mockups.filter((mockup) =>
      mockup.personas.includes(persona),
    );

    assert.ok(personaMockups.length > 0, `${persona} needs at least one mockup`);
    assert.ok(
      personaMockups.some((mockup) => mockup.questionsAnswered.some((question) => question.length > 20)),
      `${persona} needs concrete operating questions`,
    );
  }
});

test("fixtures include artifact, evidence, review, payout, support, and limitation fields", () => {
  for (const fixture of VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.fixtures) {
    for (const field of REQUIRED_PUBLISHER_PORTAL_FIXTURE_FIELDS) {
      assert.ok(fixture[field], `${fixture.id} missing ${field}`);
    }

    assert.match(fixture.artifactMetadata, /artifact|bundle|capability|package/i);
    assert.match(fixture.evidenceState, /complete|required|missing|stale|yanked|rejected/i);
    assert.match(fixture.reviewOutcome, /ready|limited|installable|rejected|yanked|escalated/i);
    assert.match(fixture.payoutReadinessHandoff, /handoff|blocked|unsupported|not eligible|owner/i);
    assert.match(fixture.supportWording, /customer-safe|support|limitation|remediation|owner/i);
    assert.match(fixture.customerVisibleLimitation, /limited|blocked|unsupported|not installable|scope-out/i);
    assert.ok(REQUIRED_PUBLISHER_PORTAL_PROOF_MODES.includes(fixture.proofMode));
  }
});

test("scenario paths, proof modes, accessibility notes, and dependency refs cover acceptance", () => {
  assert.deepEqual(
    VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.scenarioPaths.map((scenario) => scenario.id),
    REQUIRED_PUBLISHER_PORTAL_SCENARIOS,
  );

  assert.deepEqual(
    [...new Set(VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.fixtures.map((fixture) => fixture.proofMode))],
    REQUIRED_PUBLISHER_PORTAL_PROOF_MODES,
  );

  const accessibilityText = VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.accessibilityNotes.join(" ").toLowerCase();
  for (const topic of REQUIRED_PUBLISHER_PORTAL_ACCESSIBILITY_TOPICS) {
    assert.match(accessibilityText, new RegExp(topic));
  }

  for (const requiredRef of [
    "docs/design/publisher-portal.md",
    "docs/design/capability-review-approval.md",
    "docs/design/marketplace-publisher-trust-evidence.md",
    "docs/design/marketplace-payout-hooks.md",
    "docs/design/org-catalogs.md",
    "docs/design/launch-support-escalation.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ]) {
    assert.ok(VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.designRefs.includes(requiredRef));
  }
});

test("publisher portal mockups consume accepted HOBO-577 quickstart fixture ids", () => {
  assert.deepEqual(
    VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.quickstartFixtureRefs.map((ref) => ref.fixtureId),
    REQUIRED_PUBLISHER_PORTAL_QUICKSTART_FIXTURE_IDS,
  );
  assert.ok(VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.quickstartFixtureRefs.every((ref) => ref.sourceIssue === "HOBO-577"));
  assert.deepEqual(
    [...new Set(VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.quickstartFixtureRefs.map((ref) => ref.proofMode))],
    REQUIRED_PUBLISHER_PORTAL_QUICKSTART_PROOF_MODES,
  );
  assert.ok(VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.quickstartFixtureRefs.every((ref) => ref.publisherUse.length > 30));
});

test("Pact and CUE artifacts stay aligned with the parsed fixture shape", () => {
  const pact = JSON.parse(
    readFileSync(
      join(packageRoot, "architecture", "pacts", "vibe_publisher_portal_review_mockups.pact.json"),
      "utf8",
    ),
  );
  const body = pact.interactions[0].response.body;
  const pactMockups = parseVibePublisherPortalReviewMockups(
    // SAFETY: `body as typeof VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS,` is required at this I/O or test boundary.
    body as typeof VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS,
  );

  assert.deepEqual(pactMockups.personas, REQUIRED_PUBLISHER_PORTAL_PERSONAS);
  assert.deepEqual(
    pactMockups.mockups.map((mockup) => mockup.state),
    REQUIRED_PUBLISHER_PORTAL_STATES,
  );
  assert.deepEqual(
    pactMockups.fixtures.map((fixture) => fixture.id),
    VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.fixtures.map((fixture) => fixture.id),
  );
  assert.deepEqual(
    pactMockups.quickstartFixtureRefs.map((ref) => ref.fixtureId),
    REQUIRED_PUBLISHER_PORTAL_QUICKSTART_FIXTURE_IDS,
  );

  const cue = readFileSync(
    join(packageRoot, "architecture", "vibe_publisher_portal_review_mockups.cue"),
    "utf8",
  );
  assert.doesNotMatch(cue, /#VibePublisherPortalProofMode:[^\n]*unspecified/);
  assert.match(cue, /#NonEmptyStringList:\s+\[string, \.\.\.string\]/);
  assert.match(cue, /artifactMetadata:\s+string & !=""/);
  assert.match(cue, /evidenceState:\s+string & !=""/);
  assert.match(cue, /reviewOutcome:\s+string & !=""/);
  assert.match(cue, /payoutReadinessHandoff:\s+string & !=""/);
  assert.match(cue, /customerVisibleLimitation:\s+string & !=""/);
  assert.match(cue, /quickstartFixtureRefs:\s+\[#VibePublisherPortalQuickstartFixtureReference/);
  assert.match(cue, /sourceIssue:\s+"HOBO-577"/);

  const proto = readFileSync(
    join(packageRoot, "architecture", "vibe_publisher_portal_review_mockups.proto"),
    "utf8",
  );
  assert.match(proto, /message VibePublisherPortalQuickstartFixtureReference/);
  assert.match(proto, /repeated VibePublisherPortalQuickstartFixtureReference quickstart_fixture_refs/);
});

test("parser rejects missing fixture metadata and unsupported proof modes", () => {
  assert.throws(
    () =>
      parseVibePublisherPortalReviewMockups({
        ...VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS,
        fixtures: [
          {
            ...VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.fixtures[0],
            evidenceState: "",
          },
          ...VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.fixtures.slice(1),
        ],
      }),
    VibePublisherPortalReviewMockupsParseError,
  );

  assert.throws(
    () =>
      parseVibePublisherPortalReviewMockups({
        ...VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS,
        fixtures: [
          {
            ...VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.fixtures[0],
            // SAFETY: `proofMode: "production-live" as never,` is required at this I/O or test boundary.
            proofMode: "production-live" as never,
          },
          ...VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.fixtures.slice(1),
        ],
      }),
    VibePublisherPortalReviewMockupsParseError,
  );
});

test("adversarial scope-out requests fail closed instead of becoming portal implementation", () => {
  const classifications = [
    "build publisher onboarding service",
    "host artifacts in registry storage",
    "execute payout implementation",
    "run a security scanner",
    "ship the production publisher portal UI",
    "build support tooling",
    "load customer data into the portal",
    "publish launch claims without evidence",
  ].map(classifyPublisherPortalReviewMockupRequest);

  assert.deepEqual(classifications, [
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
  ]);
  assert.equal(
    classifyPublisherPortalReviewMockupRequest("add a customer-safe review remediation fixture"),
    "in-scope-proof",
  );
});

test("validator reports missing required states and fixture fields", () => {
  const validation = validateVibePublisherPortalReviewMockups({
    ...VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS,
    mockups: VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.mockups.filter((mockup) => mockup.state !== "yank-remediation"),
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.code === "missing-mockup-state"));
});

test("validator rejects quickstart fixture drift from HOBO-577", () => {
  assert.throws(
    () =>
      parseVibePublisherPortalReviewMockups({
        ...VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS,
        quickstartFixtureRefs: VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.quickstartFixtureRefs.filter(
          (ref) => ref.fixtureId !== "rlq-manage-stale-evidence-v1",
        ),
      }),
    VibePublisherPortalReviewMockupsParseError,
  );

  assert.throws(
    () =>
      parseVibePublisherPortalReviewMockups({
        ...VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS,
        quickstartFixtureRefs: [
          {
            ...VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.quickstartFixtureRefs[0],
            // SAFETY: `sourceIssue: "HOBO-548" as never,` is required at this I/O or test boundary.
            sourceIssue: "HOBO-548" as never,
          },
          ...VIBE_PUBLISHER_PORTAL_REVIEW_MOCKUPS.quickstartFixtureRefs.slice(1),
        ],
      }),
    VibePublisherPortalReviewMockupsParseError,
  );
});
