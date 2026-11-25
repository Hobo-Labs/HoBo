import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  REQUIRED_SNAPSHOP_ASSETS,
  REQUIRED_SNAPSHOP_PROOF_MODES,
  REQUIRED_SNAPSHOP_QUICKSTART_FIXTURE_IDS,
  REQUIRED_SNAPSHOP_SCENARIOS,
  REQUIRED_SNAPSHOP_STORY_STEPS,
  VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD,
  VibeSnapshopLaunchDemoStoryboardParseError,
  classifySnapshopStoryboardRequest,
  parseVibeSnapshopLaunchDemoStoryboard,
  renderStoryboardStepSummary,
  validateVibeSnapshopLaunchDemoStoryboard,
} from "../src/vibe-snapshop-launch-demo-storyboard.ts";

test("HOBO-555 pins issue, target paths, story steps, and proof modes", () => {
  const parsed = parseVibeSnapshopLaunchDemoStoryboard(
    VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD,
  );

  assert.equal(parsed.issue, "HOBO-555");
  assert.equal(parsed.phase, "M5");
  assert.equal(
    parsed.packagePath,
    "src/draft/exp-proofs/ux/vibe-snapshop-launch-demo-storyboard",
  );
  assert.equal(
    parsed.proofPath,
    "docs/design/proofs/vibe-snapshop-launch-demo-storyboard/README.md",
  );
  assert.deepEqual(
    parsed.storyboardSteps.map((step) => step.id),
    REQUIRED_SNAPSHOP_STORY_STEPS,
  );
  assert.deepEqual(parsed.proofModes, REQUIRED_SNAPSHOP_PROOF_MODES);
});

test("storyboard covers scaffold, local run, inspect, plan, live recording, failure recovery, and support/docs handoff", () => {
  const parsed = parseVibeSnapshopLaunchDemoStoryboard(
    VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD,
  );

  for (const step of parsed.storyboardSteps) {
    assert.ok(step.commandOrSurface.length > 0);
    assert.ok(step.evidenceObject.length > 0);
    assert.ok(step.owner.length > 0);
    assert.ok(step.safeClaim.length > 0);
    assert.match(renderStoryboardStepSummary(step), new RegExp(step.title));
  }
});

test("asset map names screenshots, recording manifest, command transcript, fixture data, docs, owner, refresh trigger, and proof mode", () => {
  const parsed = parseVibeSnapshopLaunchDemoStoryboard(
    VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD,
  );

  assert.deepEqual(
    parsed.assetMap.map((asset) => asset.kind),
    REQUIRED_SNAPSHOP_ASSETS,
  );

  for (const asset of parsed.assetMap) {
    assert.ok(asset.owner.length > 0);
    assert.ok(asset.refreshTrigger.length > 0);
    assert.ok(asset.source.length > 0);
    assert.ok(asset.validationRoute.length > 0);
    assert.ok(REQUIRED_SNAPSHOP_PROOF_MODES.includes(asset.proofMode));
  }
});

test("scenario paths cover happy, blocked, stale or unknown evidence, support handoff, accessibility, and proof-mode labels", () => {
  const parsed = parseVibeSnapshopLaunchDemoStoryboard(
    VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD,
  );

  assert.deepEqual(
    parsed.scenarioPaths.map((scenario) => scenario.id),
    REQUIRED_SNAPSHOP_SCENARIOS,
  );

  const pathModes = new Set(parsed.scenarioPaths.flatMap((scenario) => scenario.proofModeLabels));
  for (const mode of REQUIRED_SNAPSHOP_PROOF_MODES) {
    assert.ok(pathModes.has(mode), `missing proof mode ${mode}`);
  }

  const accessibilityText = parsed.accessibilityNotes.join(" ").toLowerCase();
  for (const requirement of ["keyboard", "screen reader", "contrast", "responsive", "motion"]) {
    assert.match(accessibilityText, new RegExp(requirement));
  }
});

test("storyboard consumes accepted HOBO-577 quickstart fixture ids", () => {
  const parsed = parseVibeSnapshopLaunchDemoStoryboard(
    VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD,
  );

  assert.ok(parsed.quickstartFixtureRefs.every((ref) => ref.sourceIssue === "HOBO-577"));
  assert.deepEqual(
    parsed.quickstartFixtureRefs.map((ref) => ref.fixtureId),
    REQUIRED_SNAPSHOP_QUICKSTART_FIXTURE_IDS,
  );

  const byFixture = new Map(
    parsed.quickstartFixtureRefs.map((ref) => [ref.fixtureId, ref.proofMode]),
  );
  assert.equal(byFixture.get("rlq-collect-manifest-ir-v1"), "simulated");
  assert.equal(byFixture.get("rlq-inspect-event-projection-v1"), "reference-fixture");
  assert.equal(byFixture.get("rlq-recover-snapshot-restore-v1"), "reference-fixture");
  assert.equal(byFixture.get("rlq-recover-scope-out-v1"), "scope-out");
});

test("every storyboard step cites an accepted HOBO-577 quickstart fixture", () => {
  const parsed = parseVibeSnapshopLaunchDemoStoryboard(
    VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD,
  );

  for (const step of parsed.storyboardSteps) {
    assert.ok(
      REQUIRED_SNAPSHOP_QUICKSTART_FIXTURE_IDS.includes(step.fixtureId),
      `${step.id} must use an accepted HOBO-577 fixture id`,
    );
    assert.ok(
      parsed.quickstartFixtureRefs.some(
        (ref) => ref.fixtureId === step.fixtureId && ref.consumingStep === step.id,
      ),
      `${step.id} must cite ${step.fixtureId} in quickstartFixtureRefs`,
    );
  }
});

test("architecture Pact and CUE fixtures align with the parsed proof", () => {
  // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
  const pact = JSON.parse(
    readFileSync(
      new URL(
        "../architecture/pacts/vibe_snapshop_launch_demo_storyboard.pact.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    readonly interactions: ReadonlyArray<{
      readonly response: { readonly body: unknown };
    }>;
  };

  const pactProof = parseVibeSnapshopLaunchDemoStoryboard(
    pact.interactions[0].response.body,
  );
  assert.deepEqual(
    pactProof.storyboardSteps.map((step) => step.id),
    REQUIRED_SNAPSHOP_STORY_STEPS,
  );

  const cue = readFileSync(
    new URL("../architecture/vibe_snapshop_launch_demo_storyboard.cue", import.meta.url),
    "utf8",
  );
  for (const field of [
    "storyboardSteps",
    "assetMap",
    "scenarioPaths",
    "accessibilityNotes",
    "QuickstartFixtureId",
    "proofMode",
    "refreshTrigger",
  ]) {
    assert.match(cue, new RegExp(`\\b${field}\\b`));
  }
  for (const fixtureId of REQUIRED_SNAPSHOP_QUICKSTART_FIXTURE_IDS) {
    assert.match(cue, new RegExp(fixtureId));
  }
});

test("scope-out requests fail closed instead of becoming launch execution work", () => {
  const classifications = [
    "build the final launch marketing page",
    "record the final demo video",
    "provision live provider resources",
    "store provider credentials",
    "load customer data",
    "publish public launch claims without evidence",
  ].map(classifySnapshopStoryboardRequest);

  assert.deepEqual(classifications, [
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
  ]);
  assert.equal(
    classifySnapshopStoryboardRequest("add a reference fixture for stale recording evidence"),
    "in-scope-proof",
  );
});

test("parser rejects missing acceptance metadata and disconnected scenario fixtures", () => {
  assert.throws(
    () =>
      parseVibeSnapshopLaunchDemoStoryboard({
        ...VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD,
        assetMap: [
          {
            ...VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD.assetMap[0],
            refreshTrigger: "",
          },
          ...VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD.assetMap.slice(1),
        ],
      }),
    VibeSnapshopLaunchDemoStoryboardParseError,
  );

  assert.throws(
    () =>
      parseVibeSnapshopLaunchDemoStoryboard({
        ...VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD,
        scenarioPaths: [
          {
            ...VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD.scenarioPaths[0],
            stepIds: ["missing-step"],
          },
          ...VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD.scenarioPaths.slice(1),
        ],
      }),
    VibeSnapshopLaunchDemoStoryboardParseError,
  );
});

test("parser rejects quickstart fixture drift from accepted HOBO-577 evidence", () => {
  assert.throws(
    () =>
      parseVibeSnapshopLaunchDemoStoryboard({
        ...VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD,
        quickstartFixtureRefs: VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD.quickstartFixtureRefs.filter(
          (ref) => ref.fixtureId !== "rlq-collect-manifest-ir-v1",
        ),
      }),
    VibeSnapshopLaunchDemoStoryboardParseError,
  );

  assert.throws(
    () =>
      parseVibeSnapshopLaunchDemoStoryboard({
        ...VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD,
        storyboardSteps: VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD.storyboardSteps.map((step) =>
          step.id === "local-run" ? { ...step, fixtureId: "rlq-define-object-graph-v1" } : step,
        ),
      }),
    VibeSnapshopLaunchDemoStoryboardParseError,
  );
});

test("validator reports missing required storyboard steps", () => {
  const validation = validateVibeSnapshopLaunchDemoStoryboard({
    ...VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD,
    storyboardSteps: VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD.storyboardSteps.filter(
      (step) => step.id !== "failure-recovery",
    ),
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.code === "missing-storyboard-step"));
});
