import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  ACCEPTED_RISK_ROUTES,
  REQUIRED_ACCESSIBILITY_QUICKSTART_FIXTURE_IDS,
  REQUIRED_ACCESSIBILITY_QUICKSTART_PROOF_MODES,
  REQUIRED_ACCESSIBILITY_CHECKS,
  REQUIRED_LAUNCH_SURFACES,
  REQUIRED_PROOF_MODE_LABELS,
  VIBE_ACCESSIBILITY_USABILITY_CHECKLIST,
  VibeAccessibilityChecklistParseError,
  classifyChecklistRequest,
  parseVibeAccessibilityChecklist,
  summarizeSurfaceEvidence,
  validateVibeAccessibilityChecklist,
} from "../src/vibe-accessibility-usability-checklist.ts";

describe("vibe accessibility usability checklist", () => {
  it("pins the HOBO-554 issue, package path, proof path, surfaces, checks, and proof modes", () => {
    const parsed = parseVibeAccessibilityChecklist(VIBE_ACCESSIBILITY_USABILITY_CHECKLIST);

    assert.equal(parsed.issue, "HOBO-554");
    assert.equal(parsed.phase, "M1");
    assert.equal(
      parsed.packagePath,
      "src/draft/exp-proofs/ux/vibe-accessibility-usability-checklist",
    );
    assert.equal(
      parsed.proofPath,
      "docs/design/proofs/vibe-accessibility-usability-checklist/README.md",
    );
    assert.deepEqual(
      parsed.surfaceChecklist.map((surface) => surface.surface),
      REQUIRED_LAUNCH_SURFACES,
    );
    assert.deepEqual(
      parsed.checks.map((check) => check.id),
      REQUIRED_ACCESSIBILITY_CHECKS,
    );
    assert.deepEqual(
      new Set(parsed.surfaceChecklist.flatMap((surface) => surface.proofModes)),
      new Set(REQUIRED_PROOF_MODE_LABELS),
    );
  });

  it("pins accepted HOBO-577 quickstart fixture ids, proof modes, and consuming surfaces", () => {
    const parsed = parseVibeAccessibilityChecklist(VIBE_ACCESSIBILITY_USABILITY_CHECKLIST);

    assert.deepEqual(
      parsed.quickstartFixtureRefs.map((ref) => ref.fixtureId),
      REQUIRED_ACCESSIBILITY_QUICKSTART_FIXTURE_IDS,
    );
    assert.ok(parsed.quickstartFixtureRefs.every((ref) => ref.sourceIssue === "HOBO-577"));
    assert.deepEqual(
      new Set(parsed.quickstartFixtureRefs.map((ref) => ref.proofMode)),
      new Set(REQUIRED_ACCESSIBILITY_QUICKSTART_PROOF_MODES),
    );
    assert.deepEqual(
      new Set(parsed.quickstartFixtureRefs.map((ref) => ref.consumingSurface)),
      new Set(REQUIRED_LAUNCH_SURFACES),
    );
    assert.ok(parsed.quickstartFixtureRefs.every((ref) => ref.accessibilityUse.length > 30));
  });

  it("maps every vibe surface to required checks, owner, evidence mode, severity, and accepted-risk route", () => {
    const parsed = parseVibeAccessibilityChecklist(VIBE_ACCESSIBILITY_USABILITY_CHECKLIST);

    for (const surface of parsed.surfaceChecklist) {
      assert.equal(surface.requiredChecks.length, REQUIRED_ACCESSIBILITY_CHECKS.length);
      assert.ok(surface.owner.length > 0, `${surface.surface} needs owner`);
      assert.ok(surface.evidenceMode.length > 0, `${surface.surface} needs evidence mode`);
      assert.match(surface.launchSeverity, /blocker|major|minor/);
      assert.ok(ACCEPTED_RISK_ROUTES.includes(surface.acceptedRiskRoute));
    }
  });

  it("records happy, blocked, stale evidence, support handoff, accessibility, and proof-label scenarios", () => {
    const parsed = parseVibeAccessibilityChecklist(VIBE_ACCESSIBILITY_USABILITY_CHECKLIST);
    const scenarioIds = parsed.scenarios.map((scenario) => scenario.id);

    assert.deepEqual(scenarioIds, [
      "happy-path",
      "blocked-path",
      "stale-or-unknown-evidence",
      "support-handoff",
      "accessibility-notes",
      "proof-mode-labels",
    ]);
    for (const scenario of parsed.scenarios) {
      assert.ok(scenario.surfaceRefs.length > 0, `${scenario.id} needs surfaces`);
      assert.ok(scenario.requiredEvidence.length > 0, `${scenario.id} needs evidence`);
      assert.ok(scenario.safeOutcome.length > 0, `${scenario.id} needs safe outcome`);
    }
  });

  it("summarizes launch readiness impact without claiming full audit execution", () => {
    const parsed = parseVibeAccessibilityChecklist(VIBE_ACCESSIBILITY_USABILITY_CHECKLIST);
    const summary = summarizeSurfaceEvidence(parsed);

    assert.equal(summary.length, REQUIRED_LAUNCH_SURFACES.length);
    assert.ok(summary.every((entry) => entry.requiredChecks === REQUIRED_ACCESSIBILITY_CHECKS.length));
    assert.ok(summary.some((entry) => entry.launchSeverity === "launch-blocker"));
    assert.ok(summary.every((entry) => !entry.claimsFullAudit));
  });

  it("rejects drift that removes a required surface, check, proof mode, or owner route", () => {
    assert.throws(
      () =>
        parseVibeAccessibilityChecklist({
          ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST,
          surfaceChecklist: VIBE_ACCESSIBILITY_USABILITY_CHECKLIST.surfaceChecklist.filter(
            (surface) => surface.surface !== "marketplace-install",
          ),
        }),
      VibeAccessibilityChecklistParseError,
    );

    assert.throws(
      () =>
        parseVibeAccessibilityChecklist({
          ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST,
          checks: VIBE_ACCESSIBILITY_USABILITY_CHECKLIST.checks.filter(
            (check) => check.id !== "screen-reader-smoke",
          ),
        }),
      VibeAccessibilityChecklistParseError,
    );

    assert.throws(
      () =>
        parseVibeAccessibilityChecklist({
          ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST,
          surfaceChecklist: [
            {
              ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST.surfaceChecklist[0],
              proofModes: ["live"],
            },
            ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST.surfaceChecklist.slice(1),
          ],
        }),
      VibeAccessibilityChecklistParseError,
    );

    assert.throws(
      () =>
        parseVibeAccessibilityChecklist({
          ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST,
          surfaceChecklist: [
            {
              ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST.surfaceChecklist[0],
              owner: "",
            },
            ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST.surfaceChecklist.slice(1),
          ],
        }),
      VibeAccessibilityChecklistParseError,
    );

    assert.throws(
      () =>
        parseVibeAccessibilityChecklist({
          ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST,
          quickstartFixtureRefs: VIBE_ACCESSIBILITY_USABILITY_CHECKLIST.quickstartFixtureRefs.filter(
            (ref) => ref.fixtureId !== "rlq-recover-scope-out-v1",
          ),
        }),
      VibeAccessibilityChecklistParseError,
    );

    assert.throws(
      () =>
        parseVibeAccessibilityChecklist({
          ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST,
          quickstartFixtureRefs: [
            {
              ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST.quickstartFixtureRefs[0],
              // SAFETY: `sourceIssue: "HOBO-999" as never,` is required at this I/O or test boundary.
              sourceIssue: "HOBO-999" as never,
            },
            ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST.quickstartFixtureRefs.slice(1),
          ],
        }),
      VibeAccessibilityChecklistParseError,
    );

    assert.throws(
      () =>
        parseVibeAccessibilityChecklist({
          ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST,
          quickstartFixtureRefs: [
            {
              ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST.quickstartFixtureRefs[0],
              // SAFETY: `proofMode: "fake-mode" as never,` is required at this I/O or test boundary.
              proofMode: "fake-mode" as never,
            },
            ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST.quickstartFixtureRefs.slice(1),
          ],
        }),
      VibeAccessibilityChecklistParseError,
    );
  });

  it("fails closed for adversarial scope-out requests", () => {
    assert.deepEqual(
      [
        "build product UI remediation for all screens",
        "run a full accessibility audit and certify launch",
        "create an automated test suite buildout",
        "approve the launch waiver",
        "use customer data screenshots",
        "publish a launch claim without evidence",
      ].map(classifyChecklistRequest),
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
      classifyChecklistRequest("add a checklist row for keyboard evidence"),
      "in-scope-proof",
    );
  });

  it("returns structured validation errors for incomplete checklist metadata", () => {
    const validation = validateVibeAccessibilityChecklist({
      ...VIBE_ACCESSIBILITY_USABILITY_CHECKLIST,
      scenarios: VIBE_ACCESSIBILITY_USABILITY_CHECKLIST.scenarios.map((scenario) =>
        scenario.id === "support-handoff"
          ? {
              ...scenario,
              requiredEvidence: [],
            }
          : scenario,
      ),
    });

    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((error) => error.code === "incomplete-scenario"));
  });

  it("keeps Pact and CUE boundary artifacts aligned with the parsed checklist shape", () => {
    // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
    const pact = JSON.parse(
      readFileSync(
        new URL(
          "../architecture/pacts/vibe_accessibility_usability_checklist.pact.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly interactions: ReadonlyArray<{
        readonly response: { readonly body: unknown };
      }>;
    };

    const parsed = parseVibeAccessibilityChecklist(
      // SAFETY: `pact.interactions[0].response.body as typeof VIBE_ACCESSIBILITY_USABILITY_CHECKL` is required at this I/O or test boundary.
      pact.interactions[0].response.body as typeof VIBE_ACCESSIBILITY_USABILITY_CHECKLIST,
    );
    assert.deepEqual(
      parsed.surfaceChecklist.map((surface) => surface.surface),
      REQUIRED_LAUNCH_SURFACES,
    );
    assert.deepEqual(
      parsed.checks.map((check) => check.id),
      REQUIRED_ACCESSIBILITY_CHECKS,
    );
    assert.deepEqual(
      parsed.quickstartFixtureRefs.map((ref) => ref.fixtureId),
      REQUIRED_ACCESSIBILITY_QUICKSTART_FIXTURE_IDS,
    );

    const cue = readFileSync(
      new URL("../architecture/vibe_accessibility_usability_checklist.cue", import.meta.url),
      "utf8",
    );
    for (const field of [
      "packagePath",
      "proofPath",
      "surfaceChecklist",
      "requiredChecks",
      "launchSeverity",
      "acceptedRiskRoute",
      "proofModes",
      "quickstartFixtureRefs",
      "accessibilityUse",
      "requiredEvidence",
    ]) {
      assert.match(cue, new RegExp(`\\b${field}\\b`));
    }
  });
});
