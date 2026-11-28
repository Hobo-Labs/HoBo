import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ACTIVATION_RAIL_STAGES,
  VIBE_FIRST_RUN_ACTIVATION_RAIL,
} from "../../../ux/vibe-first-run-activation-rail/src/vibe-first-run-activation-rail.ts";
import {
  WORKSPACE_PROJECT_STATES,
  VIBE_WORKSPACE_PROJECT_STATE_MODEL,
} from "../../../ux/vibe-workspace-project-states/src/vibe-workspace-project-states.ts";
import {
  REQUIRED_FIRST_RUN_HANDOFF_SURFACES,
  REQUIRED_FIRST_RUN_WALKTHROUGH_PROOF_MODES,
  REQUIRED_FIRST_RUN_WALKTHROUGH_SCENARIOS,
  REQUIRED_FIRST_RUN_WALKTHROUGH_STAGES,
  VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH,
  VibeClickableFirstRunWalkthroughParseError,
  classifyClickableFirstRunWalkthroughRequest,
  parseVibeClickableFirstRunWalkthrough,
  validateVibeClickableFirstRunWalkthrough,
} from "../src/vibe-clickable-first-run-walkthrough.ts";

test("HOBO-559 walkthrough pins issue, package path, proof path, and M1 source consumption", () => {
  const parsed = parseVibeClickableFirstRunWalkthrough(VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH);

  assert.equal(parsed.issue, "HOBO-559");
  assert.equal(parsed.phase, "M2");
  assert.equal(
    parsed.packagePath,
    "src/draft/exp-proofs/ux/vibe-clickable-first-run-walkthrough",
  );
  assert.equal(
    parsed.proofPath,
    "docs/design/proofs/vibe-clickable-first-run-walkthrough/README.md",
  );
  assert.equal(parsed.consumedActivationRail.sourceIssue, "HOBO-540");
  assert.equal(parsed.consumedWorkspaceProjectStates.sourceIssue, "HOBO-541");
  assert.deepEqual(parsed.consumedActivationRail.stages, ACTIVATION_RAIL_STAGES);
  assert.deepEqual(parsed.consumedWorkspaceProjectStates.states, WORKSPACE_PROJECT_STATES);
});

test("walkthrough consumes HOBO-540 activation rail and HOBO-541 workspace/project state artifacts", () => {
  assert.deepEqual(
    VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH.steps.map((step) => step.stage),
    REQUIRED_FIRST_RUN_WALKTHROUGH_STAGES,
  );

  for (const step of VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH.steps) {
    const railStage = VIBE_FIRST_RUN_ACTIVATION_RAIL.stateModel.find(
      (candidate) => candidate.stage === step.activationRailStage,
    );
    const workspaceFixture = VIBE_WORKSPACE_PROJECT_STATE_MODEL.fixtures.find(
      (candidate) => candidate.state === step.workspaceProjectState,
    );

    assert.ok(railStage, `${step.stage} should reference a HOBO-540 activation rail stage`);
    assert.ok(workspaceFixture, `${step.stage} should reference a HOBO-541 workspace/project state`);
    assert.match(step.clickableAction, /snapshop|workspace|project|plan|recover|proof|fixture/i);
    assert.match(step.snapshopFixture.snapshopContext, /snapshop/i);
    assert.match(step.snapshopFixture.quickstartFixtureId, /^rlq-[a-z0-9-]+-v[0-9]+$/);
    assert.match(step.docsHandoff, /^docs\/design\/proofs\//);
    assert.match(step.supportHandoff, /support|owner|route|redact/i);
  }
});

test("deterministic snapshop scenario paths cover workspace entry through value proof", () => {
  assert.deepEqual(
    VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH.scenarioPaths.map((scenario) => scenario.id),
    REQUIRED_FIRST_RUN_WALKTHROUGH_SCENARIOS,
  );

  const allScenarioStages = new Set(
    VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH.scenarioPaths.flatMap((scenario) => scenario.stageIds),
  );
  for (const stage of REQUIRED_FIRST_RUN_WALKTHROUGH_STAGES) {
    assert.ok(allScenarioStages.has(stage), `${stage} should appear in a deterministic scenario`);
  }
});

test("docs and support handoff routes cover portal, tutorials, troubleshooting, and support workflow", () => {
  const parsed = parseVibeClickableFirstRunWalkthrough(VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH);

  assert.deepEqual(
    parsed.handoffRoutes.map((route) => route.surface),
    REQUIRED_FIRST_RUN_HANDOFF_SURFACES,
  );

  for (const route of parsed.handoffRoutes) {
    assert.match(route.trigger, /workspace|project|blocked|stale|recovery|support|tutorial/i);
    assert.match(route.evidenceAnchor, /^docs\/design\/proofs\//);
    assert.match(route.customerSafeMessage, /fixture|simulated|redact|support|docs|owner|evidence/i);
  }
});

test("proof modes, support handoff, accessibility, and evidence states are explicit", () => {
  const proofModes = new Set(VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH.steps.map((step) => step.proofMode));
  assert.deepEqual([...proofModes], REQUIRED_FIRST_RUN_WALKTHROUGH_PROOF_MODES);

  const support = VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH.supportHandoffEvidence;
  assert.match(support.severity, /sev[0-3]/i);
  assert.match(support.redactionState, /redacted|customer-safe/i);
  assert.match(support.nextUpdateCondition, /owner|evidence|customer|support/i);

  const notes = VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH.accessibilityNotes.join(" ");
  assert.match(notes, /keyboard/i);
  assert.match(notes, /screen reader/i);
  assert.match(notes, /color/i);
  assert.match(notes, /motion/i);
});

test("parser rejects missing scenario coverage and consumed source drift", () => {
  assert.throws(
    () =>
      parseVibeClickableFirstRunWalkthrough({
        ...VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH,
        scenarioPaths: VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH.scenarioPaths.filter(
          (scenario) => scenario.id !== "support-handoff",
        ),
      }),
    VibeClickableFirstRunWalkthroughParseError,
  );

  assert.throws(
    () =>
      parseVibeClickableFirstRunWalkthrough({
        ...VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH,
        consumedActivationRail: {
          ...VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH.consumedActivationRail,
          stages: VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH.consumedActivationRail.stages.filter(
            (stage) => stage !== "project",
          ),
        },
      }),
    VibeClickableFirstRunWalkthroughParseError,
  );

  assert.throws(
    () =>
      parseVibeClickableFirstRunWalkthrough({
        ...VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH,
        consumedWorkspaceProjectStates: {
          ...VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH.consumedWorkspaceProjectStates,
          // SAFETY: `proofPath: "docs/design/proofs/other/README.md" as never,` is required at this I/O or test boundary.
          proofPath: "docs/design/proofs/other/README.md" as never,
        },
      }),
    VibeClickableFirstRunWalkthroughParseError,
  );
});

test("validator reports stale or unknown evidence that tries to appear green", () => {
  const validation = validateVibeClickableFirstRunWalkthrough({
    ...VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH,
    scenarioPaths: VIBE_CLICKABLE_FIRST_RUN_WALKTHROUGH.scenarioPaths.map((scenario) =>
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
    "ship production onboarding UI",
    "wire auth service into first run",
    "call a live provider for snapshop deploy",
    "load customer data into walkthrough fixtures",
    "publish launch claims without evidence",
  ].map(classifyClickableFirstRunWalkthroughRequest);

  assert.deepEqual(classifications, [
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
  ]);
  assert.equal(
    classifyClickableFirstRunWalkthroughRequest("add a snapshop fixture step to the walkthrough"),
    "in-scope-proof",
  );
});
