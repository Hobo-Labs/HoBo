import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_PILOT_STORYBOARD_PERSONAS,
  REQUIRED_PILOT_STORYBOARD_PROOF_MODES,
  REQUIRED_PILOT_STORYBOARD_SCENARIOS,
  REQUIRED_PILOT_STORYBOARD_STAGES,
  REQUIRED_PILOT_QUICKSTART_FIXTURE_IDS,
  VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD,
  VibeFirstCustomerPilotStoryboardParseError,
  classifyPilotStoryboardRequest,
  parseVibeFirstCustomerPilotStoryboard,
  validateVibeFirstCustomerPilotStoryboard,
} from "../src/vibe-first-customer-pilot-storyboard.ts";

test("HOBO-549 storyboard contract pins issue, package path, proof path, personas, and stages", () => {
  const parsed = parseVibeFirstCustomerPilotStoryboard(VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD);

  assert.equal(parsed.issue, "HOBO-549");
  assert.equal(
    parsed.packagePath,
    "src/draft/exp-proofs/ux/vibe-first-customer-pilot-storyboard",
  );
  assert.equal(
    parsed.proofPath,
    "docs/design/proofs/vibe-first-customer-pilot-storyboard/README.md",
  );
  assert.deepEqual(parsed.personas, REQUIRED_PILOT_STORYBOARD_PERSONAS);
  assert.deepEqual(
    parsed.storyboard.map((step) => step.stage),
    REQUIRED_PILOT_STORYBOARD_STAGES,
  );
});

test("storyboard covers pilot champion, success, support, release, and security perspectives", () => {
  for (const persona of REQUIRED_PILOT_STORYBOARD_PERSONAS) {
    const personaSteps = VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD.storyboard.filter((step) =>
      step.personas.includes(persona),
    );

    assert.ok(personaSteps.length > 0, `${persona} needs at least one storyboard step`);
    assert.ok(
      personaSteps.some((step) => step.operatingQuestion.length > 30),
      `${persona} needs a concrete operating question`,
    );
  }
});

test("script artifacts disclose stage criteria, consent, proof mode, owner, safe action, and customer-safe message", () => {
  for (const artifact of VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD.scriptArtifacts) {
    assert.ok(REQUIRED_PILOT_STORYBOARD_STAGES.includes(artifact.stage));
    assert.match(artifact.entryCriteria, /consent|workspace|project|proof|blocker|support|feedback/i);
    assert.match(artifact.exitCriteria, /accepted|routed|handoff|captured|owner|next action/i);
    assert.match(artifact.consentState, /captured|not required|redacted|blocked/i);
    assert.ok(REQUIRED_PILOT_STORYBOARD_PROOF_MODES.includes(artifact.proofMode));
    assert.match(artifact.blockerCategory, /none|docs|support|product ux|engineering|cutline|security/i);
    assert.match(artifact.owner, /customer|success|support|release|security|workspace/i);
    assert.match(artifact.safeNextAction, /continue|choose|retry|handoff|route|capture|stop/i);
    assert.match(artifact.customerSafeMessage, /no secrets|fixture|simulated|safe|support|not ready|redacted/i);
  }
});

test("scenario paths, proof modes, and accessibility notes cover acceptance states", () => {
  assert.deepEqual(
    VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD.scenarioPaths.map((scenario) => scenario.id),
    REQUIRED_PILOT_STORYBOARD_SCENARIOS,
  );

  const proofModes = new Set(
    VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD.scriptArtifacts.map((artifact) => artifact.proofMode),
  );
  assert.deepEqual([...proofModes], REQUIRED_PILOT_STORYBOARD_PROOF_MODES);

  const noteText = VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD.accessibilityNotes.join(" ");
  assert.match(noteText, /keyboard/i);
  assert.match(noteText, /screen reader/i);
  assert.match(noteText, /color/i);
  assert.match(noteText, /motion/i);
});

test("pilot storyboard consumes accepted HOBO-577 quickstart fixture ids", () => {
  const parsed = parseVibeFirstCustomerPilotStoryboard(VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD);

  assert.deepEqual(
    parsed.quickstartFixtureRefs.map((ref) => ref.fixtureId),
    REQUIRED_PILOT_QUICKSTART_FIXTURE_IDS,
  );
  assert.ok(parsed.quickstartFixtureRefs.every((ref) => ref.sourceIssue === "HOBO-577"));
  assert.ok(parsed.quickstartFixtureRefs.every((ref) => ref.pilotUse.length > 30));
});

test("parser rejects missing script metadata and unsupported proof-mode labels", () => {
  assert.throws(
    () =>
      parseVibeFirstCustomerPilotStoryboard({
        ...VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD,
        scriptArtifacts: [
          {
            ...VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD.scriptArtifacts[0],
            customerSafeMessage: "",
          },
          ...VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD.scriptArtifacts.slice(1),
        ],
      }),
    VibeFirstCustomerPilotStoryboardParseError,
  );

  assert.throws(
    () =>
      parseVibeFirstCustomerPilotStoryboard({
        ...VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD,
        scriptArtifacts: [
          {
            ...VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD.scriptArtifacts[0],
            // SAFETY: `proofMode: "customer-live" as never,` is required at this I/O or test boundary.
            proofMode: "customer-live" as never,
          },
          ...VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD.scriptArtifacts.slice(1),
        ],
      }),
    VibeFirstCustomerPilotStoryboardParseError,
  );
});

test("parser rejects quickstart fixture drift from HOBO-577", () => {
  assert.throws(
    () =>
      parseVibeFirstCustomerPilotStoryboard({
        ...VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD,
        quickstartFixtureRefs: VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD.quickstartFixtureRefs.filter(
          (ref) => ref.fixtureId !== "rlq-deploy-run-accepted-v1",
        ),
      }),
    VibeFirstCustomerPilotStoryboardParseError,
  );

  assert.throws(
    () =>
      parseVibeFirstCustomerPilotStoryboard({
        ...VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD,
        quickstartFixtureRefs: [
          {
            ...VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD.quickstartFixtureRefs[0],
            // SAFETY: `sourceIssue: "HOBO-549" as never,` is required at this I/O or test boundary.
            sourceIssue: "HOBO-549" as never,
          },
          ...VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD.quickstartFixtureRefs.slice(1),
        ],
      }),
    VibeFirstCustomerPilotStoryboardParseError,
  );
});

test("adversarial scope-out requests fail closed instead of becoming onboarding implementation", () => {
  const classifications = [
    "build the CRM workflow",
    "ship customer success automation",
    "create support tooling and queues",
    "import live customer data",
    "mutate a production tenant",
    "deploy to a real provider",
    "publish launch claims without evidence",
  ].map(classifyPilotStoryboardRequest);

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
    classifyPilotStoryboardRequest("add a reference fixture label to the pilot storyboard"),
    "in-scope-proof",
  );
});

test("validator reports missing required scenario coverage", () => {
  const validation = validateVibeFirstCustomerPilotStoryboard({
    ...VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD,
    scenarioPaths: VIBE_FIRST_CUSTOMER_PILOT_STORYBOARD.scenarioPaths.filter(
      (scenario) => scenario.id !== "support-handoff",
    ),
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.code === "missing-scenario-path"));
});
