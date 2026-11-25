import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_PLAN_REVIEW_PERSONAS,
  REQUIRED_PLAN_REVIEW_PROOF_MODES,
  REQUIRED_PLAN_REVIEW_SCENARIOS,
  REQUIRED_PLAN_REVIEW_STATES,
  REQUIRED_PLAN_REVIEW_SURFACES,
  REQUIRED_PLAN_REVIEW_QUICKSTART_FIXTURE_IDS,
  VIBE_PLAN_REVIEW_STATES,
  VibePlanReviewStatesParseError,
  classifyPlanReviewRequest,
  parseVibePlanReviewStates,
  validateVibePlanReviewStates,
} from "../src/vibe-plan-review-states.ts";

test("HOBO-542 plan review contract pins issue, package path, proof path, personas, and surfaces", () => {
  const parsed = parseVibePlanReviewStates(VIBE_PLAN_REVIEW_STATES);

  assert.equal(parsed.issue, "HOBO-542");
  assert.equal(parsed.phase, "M1");
  assert.equal(parsed.packagePath, "src/draft/exp-proofs/ux/vibe-plan-review-states");
  assert.equal(parsed.proofPath, "docs/design/proofs/vibe-plan-review-states/README.md");
  assert.deepEqual(parsed.personas, REQUIRED_PLAN_REVIEW_PERSONAS);
  assert.deepEqual(
    parsed.reviewSurfaces.map((surface) => surface.id),
    REQUIRED_PLAN_REVIEW_SURFACES,
  );
});

test("fixtures distinguish create, update, no-op, destructive, blocked, stale, and unknown evidence states", () => {
  const parsed = parseVibePlanReviewStates(VIBE_PLAN_REVIEW_STATES);

  assert.deepEqual(
    parsed.planStates.map((state) => state.id),
    REQUIRED_PLAN_REVIEW_STATES,
  );

  for (const state of parsed.planStates) {
    assert.match(state.evidenceSource, /fixture|Gatekeeper|Delta|projection|migration|rollback/i);
    assert.match(state.owner, /Plan\/Diff|Control Plane|Security|Reliability|Support|Developer/i);
    assert.match(state.safeNextAction, /approve|review|wait|open|handoff|revise|block/i);
    assert.match(state.customerSafeWording, /preview|blocked|stale|unknown|safe|destructive|no change/i);
    assert.ok(REQUIRED_PLAN_REVIEW_PROOF_MODES.includes(state.proofMode));
  }
});

test("risk, policy, cost, capacity, approval, and support surfaces answer required personas", () => {
  const parsed = parseVibePlanReviewStates(VIBE_PLAN_REVIEW_STATES);

  for (const persona of REQUIRED_PLAN_REVIEW_PERSONAS) {
    const surfaces = parsed.reviewSurfaces.filter((surface) => surface.personas.includes(persona));

    assert.ok(surfaces.length > 0, `${persona} needs at least one review surface`);
    assert.ok(
      surfaces.some((surface) => surface.questionsAnswered.some((question) => question.length > 20)),
      `${persona} needs concrete operating questions`,
    );
  }

  assert.deepEqual(
    parsed.reviewSurfaces.map((surface) => surface.id),
    REQUIRED_PLAN_REVIEW_SURFACES,
  );
});

test("scenario paths, proof-mode labels, accessibility notes, and support handoff cover acceptance", () => {
  const parsed = parseVibePlanReviewStates(VIBE_PLAN_REVIEW_STATES);

  assert.deepEqual(
    parsed.scenarioPaths.map((scenario) => scenario.id),
    REQUIRED_PLAN_REVIEW_SCENARIOS,
  );
  assert.deepEqual(
    new Set(parsed.planStates.map((state) => state.proofMode)),
    new Set(REQUIRED_PLAN_REVIEW_PROOF_MODES),
  );

  const accessibilityText = parsed.accessibilityNotes.join(" ");
  assert.match(accessibilityText, /keyboard/i);
  assert.match(accessibilityText, /screen reader/i);
  assert.match(accessibilityText, /contrast/i);
  assert.match(accessibilityText, /reduced motion/i);

  assert.match(parsed.supportHandoff.safeAction, /handoff|open/i);
  assert.match(parsed.supportHandoff.customerSafeMessage, /customer-safe/i);
  assert.match(parsed.supportHandoff.redactionBoundary, /tenant|credential|provider/i);
});

test("plan review cites accepted HOBO-577 quickstart fixture ids and consumer handoff", () => {
  const parsed = parseVibePlanReviewStates(VIBE_PLAN_REVIEW_STATES);

  assert.deepEqual(
    parsed.quickstartFixtureRefs.map((ref) => ref.fixtureId),
    REQUIRED_PLAN_REVIEW_QUICKSTART_FIXTURE_IDS,
  );
  assert.ok(parsed.quickstartFixtureRefs.every((ref) => ref.sourceIssue === "HOBO-577"));
  assert.ok(parsed.quickstartFixtureRefs.every((ref) => ref.consumer === "Plan/Diff"));
});

test("parser rejects missing state metadata, unsupported proof modes, and quickstart drift", () => {
  assert.throws(
    () =>
      parseVibePlanReviewStates({
        ...VIBE_PLAN_REVIEW_STATES,
        planStates: [
          {
            ...VIBE_PLAN_REVIEW_STATES.planStates[0],
            safeNextAction: "",
          },
          ...VIBE_PLAN_REVIEW_STATES.planStates.slice(1),
        ],
      }),
    VibePlanReviewStatesParseError,
  );

  assert.throws(
    () =>
      parseVibePlanReviewStates({
        ...VIBE_PLAN_REVIEW_STATES,
        planStates: [
          {
            ...VIBE_PLAN_REVIEW_STATES.planStates[0],
            // SAFETY: `proofMode: "production-live" as never,` is required at this I/O or test boundary.
            proofMode: "production-live" as never,
          },
          ...VIBE_PLAN_REVIEW_STATES.planStates.slice(1),
        ],
      }),
    VibePlanReviewStatesParseError,
  );

  assert.throws(
    () =>
      parseVibePlanReviewStates({
        ...VIBE_PLAN_REVIEW_STATES,
        quickstartFixtureRefs: VIBE_PLAN_REVIEW_STATES.quickstartFixtureRefs.filter(
          (ref) => ref.fixtureId !== "rlq-recover-snapshot-restore-v1",
        ),
      }),
    VibePlanReviewStatesParseError,
  );
});

test("adversarial scope-out requests fail closed instead of becoming planner or production UI work", () => {
  const classifications = [
    "implement the planner and matcher here",
    "apply the plan and rollback live infrastructure",
    "call the live cost API with provider credentials",
    "ship production UI and approval workflow",
    "claim launch readiness without evidence",
  ].map(classifyPlanReviewRequest);

  assert.deepEqual(classifications, [
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
  ]);
  assert.equal(
    classifyPlanReviewRequest("add a reference fixture for unknown evidence copy"),
    "in-scope-proof",
  );
});

test("validator reports missing accepted states", () => {
  const validation = validateVibePlanReviewStates({
    ...VIBE_PLAN_REVIEW_STATES,
    planStates: VIBE_PLAN_REVIEW_STATES.planStates.filter((state) => state.id !== "destructive"),
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.code === "missing-plan-state"));
});
