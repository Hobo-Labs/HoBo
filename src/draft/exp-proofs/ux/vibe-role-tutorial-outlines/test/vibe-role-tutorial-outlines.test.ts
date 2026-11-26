import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_ROLE_TUTORIAL_COVERAGE,
  REQUIRED_ROLE_TUTORIAL_PROOF_MODES,
  REQUIRED_ROLE_TUTORIAL_QUICKSTART_FIXTURE_IDS,
  REQUIRED_TUTORIAL_ROLES,
  VIBE_ROLE_TUTORIAL_OUTLINES,
  VibeRoleTutorialOutlinesParseError,
  classifyRoleTutorialRequest,
  parseVibeRoleTutorialOutlines,
  validateVibeRoleTutorialOutlines,
} from "../src/vibe-role-tutorial-outlines.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("HOBO-552 tutorial outline proof pins issue, phase, package path, and proof path", () => {
  const parsed = parseVibeRoleTutorialOutlines(VIBE_ROLE_TUTORIAL_OUTLINES);

  assert.equal(parsed.issue, "HOBO-552");
  assert.equal(parsed.phase, "M1");
  assert.equal(parsed.packagePath, "src/draft/exp-proofs/ux/vibe-role-tutorial-outlines");
  assert.equal(parsed.proofPath, "docs/design/proofs/vibe-role-tutorial-outlines/README.md");
  assert.deepEqual(parsed.roles, REQUIRED_TUTORIAL_ROLES);
});

test("each six-role tutorial outline includes the required runnable-proof fields", () => {
  const parsed = parseVibeRoleTutorialOutlines(VIBE_ROLE_TUTORIAL_OUTLINES);

  for (const outline of parsed.outlines) {
    assert.ok(outline.personaGoal.length > 20, `${outline.role} needs a persona goal`);
    assert.ok(outline.prerequisites.length >= 2, `${outline.role} needs prerequisites`);
    assert.ok(outline.commandPath.length >= 2, `${outline.role} needs a command path`);
    assert.ok(outline.fixtureStrategy.length > 20, `${outline.role} needs fixture strategy`);
    assert.ok(outline.expectedOutputs.length >= 2, `${outline.role} needs outputs`);
    assert.ok(outline.failureBranch.length > 20, `${outline.role} needs failure branch`);
    assert.ok(outline.accessibilityNotes.length > 0, `${outline.role} needs accessibility notes`);
    assert.ok(outline.supportHandoff.length > 20, `${outline.role} needs support handoff`);
    assert.ok(outline.proofModeLabels.length > 0, `${outline.role} needs proof modes`);
  }
});

test("outlines map to the existing role walkthrough and canonical CLI/MCP surfaces", () => {
  const parsed = parseVibeRoleTutorialOutlines(VIBE_ROLE_TUTORIAL_OUTLINES);

  for (const outline of parsed.outlines) {
    assert.match(outline.walkthroughAnchor, /^docs\/design\/walkthrough\.md#/);
    assert.ok(outline.mcpTools.length > 0, `${outline.role} needs MCP tool names`);

    for (const command of outline.commandPath) {
      assert.match(
        command,
        /^(hobo (new|collect|plan|up|inspect|logs|doctor|import terraform)\b|git push\b)/,
        `${outline.role} command invents a non-canonical lifecycle verb: ${command}`,
      );
    }
  }
});

test("coverage paths, proof-mode labels, accessibility, and HOBO-577 fixture refs cover acceptance", () => {
  const parsed = parseVibeRoleTutorialOutlines(VIBE_ROLE_TUTORIAL_OUTLINES);

  assert.deepEqual(parsed.coveragePaths.map((path) => path.id), REQUIRED_ROLE_TUTORIAL_COVERAGE);
  assert.deepEqual(
    [...new Set(parsed.outlines.flatMap((outline) => outline.proofModeLabels))],
    REQUIRED_ROLE_TUTORIAL_PROOF_MODES,
  );
  assert.deepEqual(
    parsed.quickstartFixtureRefs.map((ref) => ref.fixtureId),
    REQUIRED_ROLE_TUTORIAL_QUICKSTART_FIXTURE_IDS,
  );
  assert.ok(parsed.quickstartFixtureRefs.every((ref) => ref.sourceIssue === "HOBO-577"));

  const accessibilityText = parsed.outlines.flatMap((outline) => outline.accessibilityNotes).join(" ");
  assert.match(accessibilityText, /keyboard/i);
  assert.match(accessibilityText, /screen reader/i);
  assert.match(accessibilityText, /non-visual/i);
});

test("tutorial command paths consume accepted HOBO-577 deploy, inspect, and recovery fixtures", () => {
  const parsed = parseVibeRoleTutorialOutlines(VIBE_ROLE_TUTORIAL_OUTLINES);
  const commandText = parsed.outlines.flatMap((outline) => outline.commandPath).join("\n");
  const outlineFixtureIds = new Set(parsed.outlines.flatMap((outline) => outline.quickstartFixtureIds));

  for (const fixtureId of REQUIRED_ROLE_TUTORIAL_QUICKSTART_FIXTURE_IDS) {
    assert.ok(outlineFixtureIds.has(fixtureId), `missing outline use for ${fixtureId}`);
  }
  assert.match(commandText, /rlq-deploy-run-accepted-v1/);
  assert.match(commandText, /rlq-inspect-event-projection-v1/);
  assert.match(commandText, /rlq-recover-snapshot-restore-v1/);

  for (const command of parsed.outlines.flatMap((outline) => outline.commandPath)) {
    if (/^hobo (inspect|doctor)\b/.test(command)) {
      assert.doesNotMatch(command, /rlq-plan-safe-preview-v1/, `${command} must not inspect or diagnose plan-only evidence`);
    }
  }
});

test("Pact and CUE artifacts stay aligned with the parsed tutorial outline shape", () => {
  const pact = JSON.parse(
    readFileSync(
      join(packageRoot, "architecture", "pacts", "vibe_role_tutorial_outlines.pact.json"),
      "utf8",
    ),
  );
  const pactOutlines = parseVibeRoleTutorialOutlines(
    // SAFETY: `pact.interactions[0].response.body as typeof VIBE_ROLE_TUTORIAL_OUTLINES,` is required at this I/O or test boundary.
    pact.interactions[0].response.body as typeof VIBE_ROLE_TUTORIAL_OUTLINES,
  );

  assert.deepEqual(pactOutlines.roles, REQUIRED_TUTORIAL_ROLES);
  assert.deepEqual(
    pactOutlines.quickstartFixtureRefs.map((ref) => ref.fixtureId),
    REQUIRED_ROLE_TUTORIAL_QUICKSTART_FIXTURE_IDS,
  );

  const cue = readFileSync(
    join(packageRoot, "architecture", "vibe_role_tutorial_outlines.cue"),
    "utf8",
  );
  for (const field of [
    "personaGoal",
    "prerequisites",
    "commandPath",
    "fixtureStrategy",
    "expectedOutputs",
    "failureBranch",
    "proofModeLabels",
    "mcpTools",
    "accessibilityNotes",
    "supportHandoff",
    "quickstartFixtureRefs",
  ]) {
    assert.match(cue, new RegExp(`\\b${field}\\b`));
  }
  for (const staleField of [
    "persona_goal",
    "command_path",
    "fixture_strategy",
    "expected_outputs",
    "failure_branch",
    "proof_mode_labels",
    "mcp_tools",
    "accessibility_notes",
    "support_handoff",
    "quickstart_fixture_refs",
  ]) {
    assert.doesNotMatch(cue, new RegExp(`\\b${staleField}\\b`));
  }
});

test("parser rejects missing roles, fields, proof modes, and fixture refs", () => {
  assert.throws(
    () =>
      parseVibeRoleTutorialOutlines({
        ...VIBE_ROLE_TUTORIAL_OUTLINES,
        outlines: VIBE_ROLE_TUTORIAL_OUTLINES.outlines.filter((outline) => outline.role !== "SRE"),
      }),
    VibeRoleTutorialOutlinesParseError,
  );

  assert.throws(
    () =>
      parseVibeRoleTutorialOutlines({
        ...VIBE_ROLE_TUTORIAL_OUTLINES,
        outlines: [
          {
            ...VIBE_ROLE_TUTORIAL_OUTLINES.outlines[0],
            // SAFETY: `proofModeLabels: ["production-live"] as never,` is required at this I/O or test boundary.
            proofModeLabels: ["production-live"] as never,
          },
          ...VIBE_ROLE_TUTORIAL_OUTLINES.outlines.slice(1),
        ],
      }),
    VibeRoleTutorialOutlinesParseError,
  );

  const validation = validateVibeRoleTutorialOutlines({
    ...VIBE_ROLE_TUTORIAL_OUTLINES,
    quickstartFixtureRefs: VIBE_ROLE_TUTORIAL_OUTLINES.quickstartFixtureRefs.slice(1),
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.code === "missing-quickstart-fixture"));
});

test("adversarial scope-out requests fail closed before becoming final tutorial or live-service work", () => {
  assert.deepEqual(
    [
      "write final tutorial content for docs portal",
      "run live provider execution with real credentials",
      "build hosted docs implementation",
      "capture production recordings",
      "include customer data in the tutorial",
      "make launch claims without evidence",
    ].map(classifyRoleTutorialRequest),
    [
      "scope-out",
      "scope-out",
      "scope-out",
      "scope-out",
      "scope-out",
      "scope-out",
    ],
  );
  assert.equal(
    classifyRoleTutorialRequest("add a reference fixture tutorial outline with safe support handoff"),
    "in-scope-proof",
  );
});
