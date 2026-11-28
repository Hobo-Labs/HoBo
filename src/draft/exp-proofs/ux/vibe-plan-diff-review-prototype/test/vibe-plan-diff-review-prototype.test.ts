import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  REQUIRED_GOLDEN_PLAN_STATES,
  REQUIRED_PLAN_DIFF_PROOF_MODES,
  REQUIRED_PLAN_DIFF_QUICKSTART_FIXTURE_IDS,
  REQUIRED_PLAN_DIFF_SCENARIOS,
  VIBE_PLAN_DIFF_REVIEW_PROTOTYPE,
  classifyPlanDiffRequest,
  parseVibePlanDiffReviewPrototype,
  renderGoldenPlanDiffFixture,
  renderPlanDiffSupportPacket,
  resolvePlanDiffDependencies,
} from "../src/vibe-plan-diff-review-prototype.ts";

describe("HOBO-560 plan/diff review prototype", () => {
  it("pins issue, phase, target package, proof path, and golden plan states", () => {
    const prototype = parseVibePlanDiffReviewPrototype(VIBE_PLAN_DIFF_REVIEW_PROTOTYPE);

    assert.equal(prototype.issue, "HOBO-560");
    assert.equal(prototype.phase, "M2");
    assert.equal(
      prototype.targetPackage,
      "src/draft/exp-proofs/ux/vibe-plan-diff-review-prototype",
    );
    assert.equal(
      prototype.proofNote,
      "docs/design/proofs/vibe-plan-diff-review-prototype/README.md",
    );
    assert.deepEqual(
      prototype.goldenFixtures.map((fixture) => fixture.state),
      REQUIRED_GOLDEN_PLAN_STATES,
    );
  });

  it("consumes accepted M1 plan review states and annotation pseudocode", () => {
    const dependencies = resolvePlanDiffDependencies();
    const prototype = parseVibePlanDiffReviewPrototype(VIBE_PLAN_DIFF_REVIEW_PROTOTYPE);

    assert.deepEqual(
      dependencies.map((dependency) => dependency.issue),
      ["HOBO-542", "HOBO-543", "HOBO-577"],
    );
    assert.ok(dependencies.every((dependency) => dependency.status === "accepted"));
    assert.ok(
      dependencies.some((dependency) => dependency.evidence.includes("vibe-plan-review-states")),
    );
    assert.ok(
      dependencies.some((dependency) =>
        dependency.evidence.includes("vibe-plan-annotation-pseudocode"),
      ),
    );

    for (const fixture of prototype.goldenFixtures) {
      assert.equal(fixture.planReviewStateId, fixture.state);
      assert.ok(fixture.annotationRefs.length > 0);
      assert.ok(fixture.annotationRefs.every((ref) => ref.sourceIssue === "HOBO-543"));
    }
  });

  it("reuses accepted HOBO-577 quickstart fixture ids across plan/diff surfaces", () => {
    const prototype = parseVibePlanDiffReviewPrototype(VIBE_PLAN_DIFF_REVIEW_PROTOTYPE);

    assert.deepEqual(
      prototype.quickstartFixtureRefs.map((ref) => ref.fixtureId),
      REQUIRED_PLAN_DIFF_QUICKSTART_FIXTURE_IDS,
    );
    assert.ok(prototype.quickstartFixtureRefs.every((ref) => ref.sourceIssue === "HOBO-577"));
  });

  it("projects golden fixtures with policy, cost, capacity, annotations, proof mode, and safe action", () => {
    const prototype = parseVibePlanDiffReviewPrototype(VIBE_PLAN_DIFF_REVIEW_PROTOTYPE);

    for (const fixture of prototype.goldenFixtures) {
      assert.ok(fixture.evidenceSource.length > 0);
      assert.ok(fixture.policyDisposition.length > 0);
      assert.ok(fixture.costDisposition.length > 0);
      assert.ok(fixture.capacityDisposition.length > 0);
      assert.match(fixture.safeNextAction, /approve|review|block|wait|handoff|revise/i);
      assert.ok(REQUIRED_PLAN_DIFF_PROOF_MODES.includes(fixture.proofMode));

      const summary = renderGoldenPlanDiffFixture(fixture);
      assert.match(summary, new RegExp(fixture.state));
      assert.match(summary, new RegExp(fixture.proofMode));
    }
  });

  it("covers happy, blocked, stale or unknown evidence, support handoff, accessibility, and proof-mode labels", () => {
    const prototype = parseVibePlanDiffReviewPrototype(VIBE_PLAN_DIFF_REVIEW_PROTOTYPE);

    assert.deepEqual(
      prototype.scenarios.map((scenario) => scenario.id),
      REQUIRED_PLAN_DIFF_SCENARIOS,
    );

    const scenarioStates = new Set(prototype.scenarios.flatMap((scenario) => scenario.goldenStates));
    for (const state of REQUIRED_GOLDEN_PLAN_STATES) {
      assert.ok(scenarioStates.has(state), `missing scenario coverage for ${state}`);
    }

    const proofModes = new Set(prototype.scenarios.flatMap((scenario) => scenario.proofModeLabels));
    for (const proofMode of REQUIRED_PLAN_DIFF_PROOF_MODES) {
      assert.ok(proofModes.has(proofMode), `missing proof-mode label ${proofMode}`);
    }

    const accessibilityText = prototype.accessibilityNotes.join(" ").toLowerCase();
    for (const phrase of ["keyboard", "screen reader", "color", "motion"]) {
      assert.match(accessibilityText, new RegExp(phrase));
    }
  });

  it("renders support packets without leaking withheld fields or creating live support tooling", () => {
    const prototype = parseVibePlanDiffReviewPrototype(VIBE_PLAN_DIFF_REVIEW_PROTOTYPE);
    const supportFixtures = prototype.goldenFixtures.filter(
      (fixture) =>
        fixture.state === "blocked" ||
        fixture.state === "stale" ||
        fixture.state === "unknown-evidence" ||
        fixture.state === "destructive",
    );

    assert.ok(supportFixtures.length > 0);
    for (const fixture of supportFixtures) {
      const packet = renderPlanDiffSupportPacket(fixture);

      assert.equal(packet.issue, "HOBO-560");
      assert.ok(packet.customerSafeWording.length > 0);
      assert.ok(packet.visibleFields.includes("correlationId"));
      assert.ok(packet.withheldFields.includes("providerCredential"));
      assert.ok(packet.withheldFields.includes("tenantData"));
      assert.equal(packet.liveTicketCreated, false);
    }
  });

  it("aligns Pact and CUE architecture fixtures with the parsed prototype", () => {
    // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
    const pact = JSON.parse(
      readFileSync(
        new URL("../architecture/pacts/vibe_plan_diff_review_prototype.pact.json", import.meta.url),
        "utf8",
      ),
    ) as {
      readonly interactions: ReadonlyArray<{
        readonly response: { readonly body: unknown };
      }>;
    };

    const pactPrototype = parseVibePlanDiffReviewPrototype(pact.interactions[0].response.body);
    assert.deepEqual(
      pactPrototype.goldenFixtures.map((fixture) => fixture.state),
      REQUIRED_GOLDEN_PLAN_STATES,
    );
    assert.deepEqual(
      pactPrototype.sourceDependencies.map((dependency) => dependency.issue),
      ["HOBO-542", "HOBO-543", "HOBO-577"],
    );

    const cue = readFileSync(
      new URL("../architecture/vibe_plan_diff_review_prototype.cue", import.meta.url),
      "utf8",
    );
    for (const field of [
      "goldenFixtures",
      "annotationRefs",
      "sourceIssue",
      "planReviewStateId",
      "evidenceSource",
      "policyDisposition",
      "costDisposition",
      "capacityDisposition",
      "proofMode",
      "supportHandoff",
    ]) {
      assert.match(cue, new RegExp(`\\b${field}\\b`));
    }
  });

  it("fails closed for scope-out planner, apply, approval, cost API, production UI, and launch claims", () => {
    assert.deepEqual(classifyPlanDiffRequest("implement the resource planner and matcher"), {
      allowed: false,
      reason: "planner-runtime",
    });
    assert.deepEqual(classifyPlanDiffRequest("ship apply and rollback runtime"), {
      allowed: false,
      reason: "apply-rollback",
    });
    assert.deepEqual(classifyPlanDiffRequest("build approval service workflow"), {
      allowed: false,
      reason: "approval-service",
    });
    assert.deepEqual(classifyPlanDiffRequest("call live cost api for billing"), {
      allowed: false,
      reason: "live-cost-api",
    });
    assert.deepEqual(classifyPlanDiffRequest("build production plan viewer ui"), {
      allowed: false,
      reason: "production-ui",
    });
    assert.deepEqual(classifyPlanDiffRequest("publish launch readiness claims"), {
      allowed: false,
      reason: "launch-claim",
    });
    assert.deepEqual(
      classifyPlanDiffRequest("compose accepted plan review fixtures into a reference prototype"),
      { allowed: true, reason: "reference-prototype" },
    );
  });

  it("rejects disconnected or incomplete acceptance evidence", () => {
    assert.throws(
      () =>
        parseVibePlanDiffReviewPrototype({
          ...VIBE_PLAN_DIFF_REVIEW_PROTOTYPE,
          goldenFixtures: VIBE_PLAN_DIFF_REVIEW_PROTOTYPE.goldenFixtures.filter(
            (fixture) => fixture.state !== "unknown-evidence",
          ),
        }),
      /required golden plan state/,
    );

    assert.throws(
      () =>
        parseVibePlanDiffReviewPrototype({
          ...VIBE_PLAN_DIFF_REVIEW_PROTOTYPE,
          sourceDependencies: VIBE_PLAN_DIFF_REVIEW_PROTOTYPE.sourceDependencies.filter(
            (dependency) => dependency.issue !== "HOBO-543",
          ),
        }),
      /source dependency/,
    );

    assert.throws(
      () =>
        parseVibePlanDiffReviewPrototype({
          ...VIBE_PLAN_DIFF_REVIEW_PROTOTYPE,
          accessibilityNotes: ["Keyboard order is documented.", "Screen reader labels exist."],
        }),
      /accessibility/,
    );
  });
});
