import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_DASHBOARD_MOCKUP_PERSONAS,
  REQUIRED_DASHBOARD_MOCKUP_PROOF_MODES,
  REQUIRED_DASHBOARD_MOCKUP_SCENARIOS,
  REQUIRED_DASHBOARD_MOCKUP_SURFACES,
  REQUIRED_DASHBOARD_QUICKSTART_FIXTURE_IDS,
  REQUIRED_DASHBOARD_QUICKSTART_PROOF_MODES,
  VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS,
  VibeDeploymentDashboardMockupsParseError,
  classifyDashboardMockupRequest,
  parseVibeDeploymentDashboardMockups,
  validateVibeDeploymentDashboardMockups,
} from "../src/vibe-deployment-dashboard-mockups.ts";

test("HOBO-544 mockup contract pins issue, package path, proof path, personas, and surfaces", () => {
  const parsed = parseVibeDeploymentDashboardMockups(VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS);

  assert.equal(parsed.issue, "HOBO-544");
  assert.equal(
    parsed.packagePath,
    "src/draft/exp-proofs/ux/vibe-deployment-dashboard-mockups",
  );
  assert.equal(
    parsed.proofPath,
    "docs/design/proofs/vibe-deployment-dashboard-mockups/README.md",
  );
  assert.deepEqual(VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.personas, REQUIRED_DASHBOARD_MOCKUP_PERSONAS);
  assert.deepEqual(
    VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.wireframes.map((wireframe) => wireframe.surface),
    REQUIRED_DASHBOARD_MOCKUP_SURFACES,
  );
});

test("mockups answer platform operator, developer, release, support, and security reviewer questions", () => {
  for (const persona of REQUIRED_DASHBOARD_MOCKUP_PERSONAS) {
    const personaWireframes = VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.wireframes.filter((wireframe) =>
      wireframe.personas.includes(persona),
    );

    assert.ok(personaWireframes.length > 0, `${persona} needs at least one wireframe`);
    assert.ok(
      personaWireframes.some((wireframe) =>
        wireframe.questionsAnswered.some((question) => question.length > 20),
      ),
      `${persona} needs a concrete operating question`,
    );
  }
});

test("fixtures disclose projection source, freshness, owner, tenant/RBAC disposition, safe action, and proof mode", () => {
  for (const group of VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.fieldGroups) {
    assert.match(group.projectionSource, /View|event|projection/i);
    assert.notEqual(group.freshness.status, "unspecified");
    assert.match(group.owner, /Dashboard|Control Plane|Data Plane|Security|Support|Reliability|Developer/i);
    assert.match(group.tenantRbacDisposition, /tenant|RBAC|redact|scope/i);
    assert.match(group.safeNextAction, /inspect|open|retry|wait|handoff|escalate|review/i);
    assert.ok(REQUIRED_DASHBOARD_MOCKUP_PROOF_MODES.includes(group.proofMode));
  }
});

test("scenario paths, proof-mode labels, and accessibility notes cover acceptance states", () => {
  assert.deepEqual(
    VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.scenarioPaths.map((scenario) => scenario.id),
    REQUIRED_DASHBOARD_MOCKUP_SCENARIOS,
  );

  const proofModes = new Set(
    VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.fieldGroups.map((group) => group.proofMode),
  );
  assert.deepEqual([...proofModes], REQUIRED_DASHBOARD_MOCKUP_PROOF_MODES);

  const noteText = VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.accessibilityNotes.join(" ");
  assert.match(noteText, /keyboard/i);
  assert.match(noteText, /screen reader/i);
  assert.match(noteText, /color/i);
  assert.match(noteText, /motion/i);
});

test("dashboard mockups cite accepted HOBO-577 quickstart fixture ids and proof-mode labels", () => {
  const parsed = parseVibeDeploymentDashboardMockups(VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS);

  assert.deepEqual(
    parsed.quickstartFixtureRefs.map((ref) => ref.fixtureId),
    REQUIRED_DASHBOARD_QUICKSTART_FIXTURE_IDS,
  );
  assert.ok(parsed.quickstartFixtureRefs.every((ref) => ref.sourceIssue === "HOBO-577"));
  assert.deepEqual(
    new Set(parsed.quickstartFixtureRefs.map((ref) => ref.proofMode)),
    new Set(REQUIRED_DASHBOARD_QUICKSTART_PROOF_MODES),
  );
  assert.deepEqual(
    new Set(parsed.quickstartFixtureRefs.map((ref) => ref.consumingSurface)),
    new Set(REQUIRED_DASHBOARD_MOCKUP_SURFACES),
  );
});

test("parser rejects missing metadata or unsupported proof-mode labels", () => {
  assert.throws(
    () =>
      parseVibeDeploymentDashboardMockups({
        ...VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS,
        fieldGroups: [
          {
            ...VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.fieldGroups[0],
            safeNextAction: "",
          },
          ...VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.fieldGroups.slice(1),
        ],
      }),
    VibeDeploymentDashboardMockupsParseError,
  );

  assert.throws(
    () =>
      parseVibeDeploymentDashboardMockups({
        ...VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS,
        fieldGroups: [
          {
            ...VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.fieldGroups[0],
            // SAFETY: `proofMode: "production-live" as never,` is required at this I/O or test boundary.
            proofMode: "production-live" as never,
          },
          ...VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.fieldGroups.slice(1),
        ],
      }),
    VibeDeploymentDashboardMockupsParseError,
  );
});

test("parser rejects dashboard fixture references that drift from HOBO-577", () => {
  assert.throws(
    () =>
      parseVibeDeploymentDashboardMockups({
        ...VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS,
        quickstartFixtureRefs: VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.quickstartFixtureRefs.filter(
          (ref) => ref.fixtureId !== "rlq-recover-scope-out-v1",
        ),
      }),
    VibeDeploymentDashboardMockupsParseError,
  );

  assert.throws(
    () =>
      parseVibeDeploymentDashboardMockups({
        ...VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS,
        quickstartFixtureRefs: [
          {
            ...VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.quickstartFixtureRefs[0],
            // SAFETY: `sourceIssue: "HOBO-544" as never,` is required at this I/O or test boundary.
            sourceIssue: "HOBO-544" as never,
          },
          ...VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.quickstartFixtureRefs.slice(1),
        ],
      }),
    VibeDeploymentDashboardMockupsParseError,
  );
});

test("adversarial scope-out requests fail closed instead of becoming dashboard implementation work", () => {
  const classifications = [
    "build the production dashboard frontend",
    "ship the visual graph renderer",
    "implement the projection engine and GraphQL facade",
    "traverse live provider topology",
    "implement tenant RBAC enforcement",
    "announce launch readiness without evidence",
  ].map(classifyDashboardMockupRequest);

  assert.deepEqual(classifications, [
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
    "scope-out",
  ]);
  assert.equal(
    classifyDashboardMockupRequest("add a reference fixture label for the run inspector"),
    "in-scope-proof",
  );
});

test("validator reports all missing required acceptance surfaces", () => {
  const validation = validateVibeDeploymentDashboardMockups({
    ...VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS,
    wireframes: VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS.wireframes.filter(
      (wireframe) => wireframe.surface !== "run-inspector",
    ),
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.code === "missing-wireframe-surface"));
});
