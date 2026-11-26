import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_SUPPORT_WORKFLOW_FIXTURE_FIELDS,
  REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PERSONAS,
  REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PROOF_MODES,
  REQUIRED_SUPPORT_WORKFLOW_MOCKUP_SCENARIOS,
  REQUIRED_SUPPORT_WORKFLOW_MOCKUP_STATES,
  REQUIRED_SUPPORT_WORKFLOW_QUICKSTART_FIXTURE_IDS,
  REQUIRED_SUPPORT_WORKFLOW_QUICKSTART_PROOF_MODES,
  VIBE_SUPPORT_WORKFLOW_MOCKUPS,
  VibeSupportWorkflowMockupsParseError,
  classifySupportWorkflowMockupRequest,
  parseVibeSupportWorkflowMockups,
  validateVibeSupportWorkflowMockups,
} from "../src/vibe-support-workflow-mockups.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("HOBO-550 mockup proof pins issue, phase, package path, proof path, personas, and states", () => {
  const parsed = parseVibeSupportWorkflowMockups(VIBE_SUPPORT_WORKFLOW_MOCKUPS);

  assert.equal(parsed.issue, "HOBO-550");
  assert.equal(parsed.phase, "M1");
  assert.equal(
    parsed.packagePath,
    "src/draft/exp-proofs/ux/vibe-support-workflow-mockups",
  );
  assert.equal(
    parsed.proofPath,
    "docs/design/proofs/vibe-support-workflow-mockups/README.md",
  );
  assert.deepEqual(parsed.personas, REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PERSONAS);
  assert.deepEqual(
    parsed.mockups.map((mockup) => mockup.state),
    REQUIRED_SUPPORT_WORKFLOW_MOCKUP_STATES,
  );
});

test("support workflow mockups cover all required user perspectives", () => {
  for (const persona of REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PERSONAS) {
    const personaMockups = VIBE_SUPPORT_WORKFLOW_MOCKUPS.mockups.filter((mockup) =>
      mockup.personas.includes(persona),
    );

    assert.ok(personaMockups.length > 0, `${persona} needs at least one mockup`);
    assert.ok(
      personaMockups.some((mockup) => mockup.questionsAnswered.some((question) => question.length > 20)),
      `${persona} needs concrete operating questions`,
    );
  }
});

test("fixture examples include support intake evidence fields and safe customer handling", () => {
  for (const fixture of VIBE_SUPPORT_WORKFLOW_MOCKUPS.fixtures) {
    for (const field of REQUIRED_SUPPORT_WORKFLOW_FIXTURE_FIELDS) {
      assert.ok(fixture[field], `${fixture.id} missing ${field}`);
    }

    assert.match(fixture.customerSafeSummary, /no raw|redacted|customer-safe|without/i);
    assert.match(fixture.ownerRoute, /Support|Incident|Admin|Security|Release|Docs/i);
    assert.match(fixture.nextUpdateCondition, /when|after|once|before/i);
    assert.ok(REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PROOF_MODES.includes(fixture.proofMode));
  }
});

test("scenario paths, proof-mode labels, accessibility notes, and HOBO-577 fixture refs cover acceptance", () => {
  assert.deepEqual(
    VIBE_SUPPORT_WORKFLOW_MOCKUPS.scenarioPaths.map((scenario) => scenario.id),
    REQUIRED_SUPPORT_WORKFLOW_MOCKUP_SCENARIOS,
  );

  assert.deepEqual(
    [...new Set(VIBE_SUPPORT_WORKFLOW_MOCKUPS.fixtures.map((fixture) => fixture.proofMode))],
    REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PROOF_MODES,
  );

  const accessibilityText = VIBE_SUPPORT_WORKFLOW_MOCKUPS.accessibilityNotes.join(" ");
  assert.match(accessibilityText, /keyboard/i);
  assert.match(accessibilityText, /screen reader/i);
  assert.match(accessibilityText, /contrast/i);
  assert.match(accessibilityText, /motion/i);

  assert.deepEqual(
    VIBE_SUPPORT_WORKFLOW_MOCKUPS.quickstartFixtureRefs.map((ref) => ref.fixtureId),
    REQUIRED_SUPPORT_WORKFLOW_QUICKSTART_FIXTURE_IDS,
  );
  assert.ok(VIBE_SUPPORT_WORKFLOW_MOCKUPS.quickstartFixtureRefs.every((ref) => ref.sourceIssue === "HOBO-577"));
  assert.deepEqual(
    new Set(VIBE_SUPPORT_WORKFLOW_MOCKUPS.quickstartFixtureRefs.map((ref) => ref.proofMode)),
    new Set(REQUIRED_SUPPORT_WORKFLOW_QUICKSTART_PROOF_MODES),
  );
  assert.ok(VIBE_SUPPORT_WORKFLOW_MOCKUPS.quickstartFixtureRefs.every((ref) => ref.supportUse.length > 0));
});

test("Pact and CUE artifacts stay aligned with the parsed support fixture shape", () => {
  const pact = JSON.parse(
    readFileSync(
      join(packageRoot, "architecture", "pacts", "vibe_support_workflow_mockups.pact.json"),
      "utf8",
    ),
  );
  const body = pact.interactions[0].response.body;
  // SAFETY: `const pactMockups = parseVibeSupportWorkflowMockups(body as typeof VIBE_SUPPORT_` is required at this I/O or test boundary.
  const pactMockups = parseVibeSupportWorkflowMockups(body as typeof VIBE_SUPPORT_WORKFLOW_MOCKUPS);

  assert.deepEqual(pactMockups.personas, REQUIRED_SUPPORT_WORKFLOW_MOCKUP_PERSONAS);
  assert.deepEqual(
    pactMockups.mockups.map((mockup) => mockup.state),
    REQUIRED_SUPPORT_WORKFLOW_MOCKUP_STATES,
  );
  assert.deepEqual(
    pactMockups.fixtures.map((fixture) => fixture.id),
    VIBE_SUPPORT_WORKFLOW_MOCKUPS.fixtures.map((fixture) => fixture.id),
  );
  assert.deepEqual(
    pactMockups.quickstartFixtureRefs.map((ref) => ref.fixtureId),
    REQUIRED_SUPPORT_WORKFLOW_QUICKSTART_FIXTURE_IDS,
  );

  const cue = readFileSync(
    join(packageRoot, "architecture", "vibe_support_workflow_mockups.cue"),
    "utf8",
  );
  assert.doesNotMatch(cue, /#VibeSupportWorkflowProofMode:[^\n]*unspecified/);
  assert.match(cue, /#NonEmptyStringList:\s+\[string, \.\.\.string\]/);
  assert.match(cue, /customerSafeSummary:\s+string & !=""/);
  assert.match(cue, /evidenceLinks:\s+#NonEmptyStringList/);
  assert.match(cue, /quickstartFixtureRefs:\s+\[#VibeSupportWorkflowQuickstartFixtureReference/);
  assert.match(cue, /fixtures:\s+\[#VibeSupportWorkflowFixture, \.\.\.#VibeSupportWorkflowFixture\]/);

  for (const staleField of [
    "customer_safe_summary",
    "affected_surface",
    "owner_route",
    "evidence_links",
    "redaction_state",
    "next_update_condition",
    "quickstart_fixture_refs",
    "scenario_paths",
    "accessibility_notes",
    "scope_out",
  ]) {
    assert.doesNotMatch(cue, new RegExp(`\\b${staleField}\\b`));
  }
});

test("parser rejects missing fixture metadata and unsupported proof modes", () => {
  assert.throws(
    () =>
      parseVibeSupportWorkflowMockups({
        ...VIBE_SUPPORT_WORKFLOW_MOCKUPS,
        fixtures: [
          {
            ...VIBE_SUPPORT_WORKFLOW_MOCKUPS.fixtures[0],
            ownerRoute: "",
          },
          ...VIBE_SUPPORT_WORKFLOW_MOCKUPS.fixtures.slice(1),
        ],
      }),
    VibeSupportWorkflowMockupsParseError,
  );

  assert.throws(
    () =>
      parseVibeSupportWorkflowMockups({
        ...VIBE_SUPPORT_WORKFLOW_MOCKUPS,
        fixtures: [
          {
            ...VIBE_SUPPORT_WORKFLOW_MOCKUPS.fixtures[0],
            // SAFETY: `proofMode: "production-live" as never,` is required at this I/O or test boundary.
            proofMode: "production-live" as never,
          },
          ...VIBE_SUPPORT_WORKFLOW_MOCKUPS.fixtures.slice(1),
        ],
      }),
    VibeSupportWorkflowMockupsParseError,
  );

  assert.throws(
    () =>
      parseVibeSupportWorkflowMockups({
        ...VIBE_SUPPORT_WORKFLOW_MOCKUPS,
        quickstartFixtureRefs: [
          {
            ...VIBE_SUPPORT_WORKFLOW_MOCKUPS.quickstartFixtureRefs[0],
            // SAFETY: `proofMode: "production-live" as never,` is required at this I/O or test boundary.
            proofMode: "production-live" as never,
          },
          ...VIBE_SUPPORT_WORKFLOW_MOCKUPS.quickstartFixtureRefs.slice(1),
        ],
      }),
    VibeSupportWorkflowMockupsParseError,
  );

  assert.throws(
    () =>
      parseVibeSupportWorkflowMockups({
        ...VIBE_SUPPORT_WORKFLOW_MOCKUPS,
        quickstartFixtureRefs: [
          {
            ...VIBE_SUPPORT_WORKFLOW_MOCKUPS.quickstartFixtureRefs[0],
            supportUse: "",
          },
          ...VIBE_SUPPORT_WORKFLOW_MOCKUPS.quickstartFixtureRefs.slice(1),
        ],
      }),
    VibeSupportWorkflowMockupsParseError,
  );
});

test("adversarial scope-out requests fail closed instead of becoming support workflow implementation", () => {
  const classifications = [
    "build helpdesk software",
    "automate ticket queues",
    "grant support customer-data access",
    "run incident command here",
    "implement on-call staffing",
    "ship the production support UI",
    "promise a contractual SLA",
  ].map(classifySupportWorkflowMockupRequest);

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
    classifySupportWorkflowMockupRequest("add a customer-safe support handoff fixture"),
    "in-scope-proof",
  );
});

test("validator reports missing required states and fixture fields", () => {
  const validation = validateVibeSupportWorkflowMockups({
    ...VIBE_SUPPORT_WORKFLOW_MOCKUPS,
    mockups: VIBE_SUPPORT_WORKFLOW_MOCKUPS.mockups.filter((mockup) => mockup.state !== "customer-updated"),
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.code === "missing-mockup-state"));
});
