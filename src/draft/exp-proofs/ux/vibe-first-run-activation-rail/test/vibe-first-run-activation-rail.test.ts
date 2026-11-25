import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  ACTIVATION_RAIL_STAGES,
  ACTIVATION_RAIL_ENTRY_POINTS,
  ACTIVATION_RAIL_OUTCOMES,
  ACTIVATION_RAIL_PROOF_MODES,
  VIBE_FIRST_RUN_ACTIVATION_RAIL,
  classifyActivationRailScope,
  parseVibeFirstRunActivationRail,
  summarizeActivationRailWireframes,
} from "../src/vibe-first-run-activation-rail.ts";

describe("vibe first-run activation rail", () => {
  it("pins the HOBO-540 package, proof note, personas, and activation stages", () => {
    const rail = parseVibeFirstRunActivationRail(VIBE_FIRST_RUN_ACTIVATION_RAIL);

    assert.equal(rail.issue, "HOBO-540");
    assert.equal(rail.targetPackage, "src/draft/exp-proofs/ux/vibe-first-run-activation-rail");
    assert.equal(rail.proofNote, "docs/design/proofs/vibe-first-run-activation-rail/README.md");
    assert.deepEqual(
      rail.wireframes.map((wireframe) => wireframe.entryPoint),
      ACTIVATION_RAIL_ENTRY_POINTS,
    );
    assert.deepEqual(
      rail.stateModel.map((stage) => stage.stage),
      ACTIVATION_RAIL_STAGES,
    );
  });

  it("covers app developer, team admin, platform engineer, and support operator wireframes", () => {
    const rail = parseVibeFirstRunActivationRail(VIBE_FIRST_RUN_ACTIVATION_RAIL);
    const wireframes = summarizeActivationRailWireframes(rail);

    for (const entryPoint of ACTIVATION_RAIL_ENTRY_POINTS) {
      const wireframe = wireframes.find((candidate) => candidate.entryPoint === entryPoint);
      assert.ok(wireframe, `expected ${entryPoint} wireframe`);
      assert.ok(wireframe.visibleStates.length >= 3);
      assert.ok(wireframe.primaryQuestion.length > 0);
      assert.ok(wireframe.nextAction.length > 0);
      assert.ok(wireframe.accessibilityNotes.length >= 2);
    }
  });

  it("names entry, exit, owner, evidence object, and missing-prereq behavior for every stage", () => {
    const rail = parseVibeFirstRunActivationRail(VIBE_FIRST_RUN_ACTIVATION_RAIL);

    for (const stage of rail.stateModel) {
      assert.ok(stage.entryCondition.length > 0);
      assert.ok(stage.exitCondition.length > 0);
      assert.ok(stage.owner.length > 0);
      assert.match(stage.evidenceObject, /^[a-z]+(\.[a-z-]+)+$/);
      assert.ok(stage.missingPrerequisiteBehavior.length > 0);
      assert.ok(ACTIVATION_RAIL_PROOF_MODES.includes(stage.proofMode));
      assert.ok(stage.quickstartFixtureIds.every((fixtureId) => /^rlq-[a-z0-9-]+-v[0-9]+$/.test(fixtureId)));
    }
  });

  it("covers happy, blocked, stale or unknown evidence, support handoff, and proof-mode labels", () => {
    const rail = parseVibeFirstRunActivationRail(VIBE_FIRST_RUN_ACTIVATION_RAIL);

    assert.deepEqual(
      rail.outcomes.map((outcome) => outcome.kind),
      ACTIVATION_RAIL_OUTCOMES,
    );

    const modes = new Set([
      ...rail.stateModel.map((stage) => stage.proofMode),
      ...rail.outcomes.map((outcome) => outcome.proofMode),
      ...rail.proofModeLegend.map((entry) => entry.proofMode),
    ]);
    for (const mode of ACTIVATION_RAIL_PROOF_MODES) {
      assert.ok(modes.has(mode), `expected proof mode ${mode}`);
    }
  });

  it("rejects live providers, production UI, customer data, credentials, and unsupported launch claims", () => {
    for (const proposal of [
      "Call a live provider to prove first run succeeds",
      "Ship this as production UI",
      "Use real customer data in onboarding fixtures",
      "Paste real credentials into the rail",
      "Launch claim without evidence",
    ]) {
      assert.equal(classifyActivationRailScope(proposal).allowed, false, proposal);
    }

    assert.deepEqual(classifyActivationRailScope("reference fixture state model"), {
      allowed: true,
      reason: "activation-rail-fixture",
    });
  });

  it("keeps Pact and CUE boundary artifacts aligned with the parsed rail", () => {
    // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
    const pact = JSON.parse(
      readFileSync(
        new URL("../architecture/pacts/vibe_first_run_activation_rail.pact.json", import.meta.url),
        "utf8",
      ),
    ) as {
      readonly interactions: ReadonlyArray<{
        readonly response: { readonly body: unknown };
      }>;
    };

    const pactRail = parseVibeFirstRunActivationRail(pact.interactions[0].response.body);
    assert.deepEqual(
      pactRail.stateModel.map((stage) => stage.stage),
      ACTIVATION_RAIL_STAGES,
    );

    const cue = readFileSync(
      new URL("../architecture/vibe_first_run_activation_rail.cue", import.meta.url),
      "utf8",
    );
    for (const field of [
      "targetPackage",
      "proofNote",
      "entryCondition",
      "exitCondition",
      "evidenceObject",
      "missingPrerequisiteBehavior",
      "proofMode",
      "quickstartFixtureIds",
    ]) {
      assert.match(cue, new RegExp(`\\b${field}\\b`));
    }
  });
});
