import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_PILOT_STORYBOARD_STAGES,
  VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD,
} from "../../../ux/vibe-first-customer-pilot-storyboard/src/vibe-first-customer-pilot-storyboard.ts";
import {
  REQUIRED_PILOT_FIRST_PROOF_BLOCKER_ROUTES,
  REQUIRED_PILOT_FIRST_PROOF_PROOF_MODES,
  REQUIRED_PILOT_FIRST_PROOF_SCENARIOS,
  VIBE_PILOT_FIRST_PROOF_WALKTHROUGH,
  VibePilotFirstProofWalkthroughParseError,
  classifyPilotFirstProofWalkthroughRequest,
  parseVibePilotFirstProofWalkthrough,
  validateVibePilotFirstProofWalkthrough,
} from "../src/vibe-pilot-first-proof-walkthrough.ts";

test("HOBO-563 walkthrough pins issue, package path, proof path, and HOBO-549 consumption", () => {
  const parsed = parseVibePilotFirstProofWalkthrough(VIBE_PILOT_FIRST_PROOF_WALKTHROUGH);

  assert.equal(parsed.issue, "HOBO-563");
  assert.equal(parsed.phase, "M2");
  assert.equal(
    parsed.packagePath,
    "src/draft/exp-proofs/ux/vibe-pilot-first-proof-walkthrough",
  );
  assert.equal(
    parsed.proofPath,
    "docs/design/proofs/vibe-pilot-first-proof-walkthrough/README.md",
  );
  assert.equal(parsed.consumedStoryboard.sourceIssue, "HOBO-549");
  assert.deepEqual(parsed.consumedStoryboard.stages, REQUIRED_PILOT_STORYBOARD_STAGES);
});

test("walkthrough keeps every HOBO-549 storyboard stage in accepted order", () => {
  assert.deepEqual(
    VIBE_PILOT_FIRST_PROOF_WALKTHROUGH.steps.map((step) => step.stage),
    REQUIRED_PILOT_STORYBOARD_STAGES,
  );

  for (const step of VIBE_PILOT_FIRST_PROOF_WALKTHROUGH.steps) {
    const sourceStep = VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD.storyboard.find(
      (candidate) => candidate.stage === step.sourceStoryboardStage,
    );

    assert.ok(sourceStep, `${step.stage} should reference a HOBO-549 storyboard stage`);
    assert.match(step.userAction, /invite|workspace|project|proof|recover|support|feedback/i);
    assert.match(step.expectedEvidence, /fixture|proof|blocker|handoff|feedback|route/i);
    assert.match(step.customerSafeMessage, /no secrets|simulated|fixture|redacted|support|not ready|safe/i);
  }
});

test("deterministic scenario paths cover invite through feedback capture", () => {
  assert.deepEqual(
    VIBE_PILOT_FIRST_PROOF_WALKTHROUGH.scenarioPaths.map((scenario) => scenario.id),
    REQUIRED_PILOT_FIRST_PROOF_SCENARIOS,
  );

  const allScenarioStages = new Set(
    VIBE_PILOT_FIRST_PROOF_WALKTHROUGH.scenarioPaths.flatMap((scenario) => scenario.stageIds),
  );
  for (const stage of REQUIRED_PILOT_STORYBOARD_STAGES) {
    assert.ok(allScenarioStages.has(stage), `${stage} should appear in a deterministic scenario`);
  }
});

test("blocker routing covers cutline, docs, product UX, support, and engineering owners", () => {
  const parsed = parseVibePilotFirstProofWalkthrough(VIBE_PILOT_FIRST_PROOF_WALKTHROUGH);

  assert.deepEqual(
    parsed.blockerRoutes.map((route) => route.route),
    REQUIRED_PILOT_FIRST_PROOF_BLOCKER_ROUTES,
  );

  for (const route of parsed.blockerRoutes) {
    assert.match(route.trigger, /blocked|missing|stale|unknown|failure|unsafe/i);
    assert.match(route.safeNextAction, /route|handoff|open|refresh|stop|replay/i);
    assert.match(route.customerSafeMessage, /not ready|support|docs|owner|evidence|redacted/i);
  }
});

test("proof modes, support handoff, accessibility, and evidence states are explicit", () => {
  const proofModes = new Set(VIBE_PILOT_FIRST_PROOF_WALKTHROUGH.steps.map((step) => step.proofMode));
  assert.deepEqual([...proofModes], REQUIRED_PILOT_FIRST_PROOF_PROOF_MODES);

  const support = VIBE_PILOT_FIRST_PROOF_WALKTHROUGH.supportHandoffEvidence;
  assert.match(support.severity, /sev[0-3]/i);
  assert.match(support.redactionState, /redacted|customer-safe/i);
  assert.match(support.nextUpdateCondition, /owner|evidence|customer|support/i);

  const notes = VIBE_PILOT_FIRST_PROOF_WALKTHROUGH.accessibilityNotes.join(" ");
  assert.match(notes, /keyboard/i);
  assert.match(notes, /screen reader/i);
  assert.match(notes, /color/i);
  assert.match(notes, /motion/i);
});

test("parser rejects missing scenario coverage and HOBO-549 stage drift", () => {
  assert.throws(
    () =>
      parseVibePilotFirstProofWalkthrough({
        ...VIBE_PILOT_FIRST_PROOF_WALKTHROUGH,
        scenarioPaths: VIBE_PILOT_FIRST_PROOF_WALKTHROUGH.scenarioPaths.filter(
          (scenario) => scenario.id !== "support-handoff",
        ),
      }),
    VibePilotFirstProofWalkthroughParseError,
  );

  assert.throws(
    () =>
      parseVibePilotFirstProofWalkthrough({
        ...VIBE_PILOT_FIRST_PROOF_WALKTHROUGH,
        consumedStoryboard: {
          ...VIBE_PILOT_FIRST_PROOF_WALKTHROUGH.consumedStoryboard,
          stages: VIBE_PILOT_FIRST_PROOF_WALKTHROUGH.consumedStoryboard.stages.filter(
            (stage) => stage !== "project-choice",
          ),
        },
      }),
    VibePilotFirstProofWalkthroughParseError,
  );

  assert.throws(
    () =>
      parseVibePilotFirstProofWalkthrough({
        ...VIBE_PILOT_FIRST_PROOF_WALKTHROUGH,
        consumedStoryboard: {
          ...VIBE_PILOT_FIRST_PROOF_WALKTHROUGH.consumedStoryboard,
          // SAFETY: `proofPath: "docs/design/proofs/other/README.md" as never,` is required at this I/O or test boundary.
          proofPath: "docs/design/proofs/other/README.md" as never,
        },
      }),
    VibePilotFirstProofWalkthroughParseError,
  );
});

test("validator reports stale or unknown evidence that tries to appear green", () => {
  const validation = validateVibePilotFirstProofWalkthrough({
    ...VIBE_PILOT_FIRST_PROOF_WALKTHROUGH,
    scenarioPaths: VIBE_PILOT_FIRST_PROOF_WALKTHROUGH.scenarioPaths.map((scenario) =>
      scenario.id === "stale-or-unknown-evidence"
        ? { ...scenario, safeOutcome: "mark ready and continue launch" }
        : scenario,
    ),
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.code === "unsafe-stale-outcome"));
});

test("adversarial scope-out requests fail closed", () => {
  const classifications = [
    "build customer success automation",
    "sync the pilot to a CRM",
    "load live customer data",
    "mutate the production tenant",
    "deploy this to a real provider",
    "create support tooling and queues",
    "publish launch claims without evidence",
  ].map(classifyPilotFirstProofWalkthroughRequest);

  assert.deepEqual(classifications, [
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
  ]);
  assert.equal(
    classifyPilotFirstProofWalkthroughRequest("add a blocker route fixture to the walkthrough"),
    "in-scope-proof",
  );
});
