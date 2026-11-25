import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  REQUIRED_REPRESENTATIVE_ARTIFACTS,
  REQUIRED_REPRESENTATIVE_CHECKS,
  REQUIRED_REPRESENTATIVE_QUICKSTART_FIXTURE_IDS,
  REQUIRED_REPRESENTATIVE_SCENARIOS,
  REQUIRED_REPRESENTATIVE_SOURCE_ISSUES,
  VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS,
  VibeRepresentativeChecksParseError,
  classifyRepresentativeCheckRequest,
  parseVibeRepresentativeA11yUsabilityChecks,
  summarizeArtifactReadiness,
  validateVibeRepresentativeA11yUsabilityChecks,
} from "../src/vibe-representative-a11y-usability-checks.ts";

describe("vibe representative accessibility and usability checks", () => {
  it("pins the HOBO-565 issue, package path, proof path, artifacts, checks, and proof modes", () => {
    const parsed = parseVibeRepresentativeA11yUsabilityChecks(
      VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS,
    );

    assert.equal(parsed.issue, "HOBO-565");
    assert.equal(parsed.phase, "M2");
    assert.equal(
      parsed.packagePath,
      "src/draft/exp-proofs/ux/vibe-representative-a11y-usability-checks",
    );
    assert.equal(
      parsed.proofPath,
      "docs/design/proofs/vibe-representative-a11y-usability-checks/README.md",
    );
    assert.deepEqual(
      parsed.artifactChecks.map((artifact) => artifact.artifact),
      REQUIRED_REPRESENTATIVE_ARTIFACTS,
    );
    assert.deepEqual(
      parsed.checkDefinitions.map((check) => check.id),
      REQUIRED_REPRESENTATIVE_CHECKS,
    );
    assert.deepEqual(new Set(parsed.proofModeLabels), new Set([
      "live",
      "simulated",
      "reference fixture",
      "scope-out",
    ]));
  });

  it("consumes accepted HOBO-554 checklist coverage and HOBO-577 quickstart fixtures", () => {
    const parsed = parseVibeRepresentativeA11yUsabilityChecks(
      VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS,
    );

    assert.deepEqual(parsed.sourceIssues, REQUIRED_REPRESENTATIVE_SOURCE_ISSUES);
    assert.ok(parsed.artifactChecks.every((artifact) => artifact.checklistSourceIssue === "HOBO-554"));
    assert.deepEqual(
      parsed.quickstartFixtureRefs.map((ref) => ref.fixtureId),
      REQUIRED_REPRESENTATIVE_QUICKSTART_FIXTURE_IDS,
    );
    assert.ok(parsed.quickstartFixtureRefs.every((ref) => ref.sourceIssue === "HOBO-577"));
    assert.deepEqual(
      new Set(parsed.quickstartFixtureRefs.map((ref) => ref.consumingArtifact)),
      new Set(REQUIRED_REPRESENTATIVE_ARTIFACTS),
    );
  });

  it("maps every representative artifact to every required check with evidence, owner, risk, and readiness impact", () => {
    const parsed = parseVibeRepresentativeA11yUsabilityChecks(
      VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS,
    );

    for (const artifact of parsed.artifactChecks) {
      assert.equal(artifact.checks.length, REQUIRED_REPRESENTATIVE_CHECKS.length);
      assert.ok(artifact.ownerRoute.length > 0, `${artifact.artifact} needs owner route`);
      assert.ok(artifact.acceptedRiskPath.length > 0, `${artifact.artifact} needs accepted-risk path`);
      for (const check of artifact.checks) {
        assert.ok(REQUIRED_REPRESENTATIVE_CHECKS.includes(check.checkId));
        assert.ok(check.expectedEvidence.length > 0, `${artifact.artifact}:${check.checkId} needs evidence`);
        assert.match(check.severity, /launch-blocker|major|minor/);
        assert.ok(check.launchReadinessImpact.length > 0, `${artifact.artifact}:${check.checkId} needs impact`);
      }
    }
  });

  it("covers happy, blocked, stale evidence, support handoff, accessibility notes, and proof labels", () => {
    const parsed = parseVibeRepresentativeA11yUsabilityChecks(
      VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS,
    );

    assert.deepEqual(
      parsed.scenarios.map((scenario) => scenario.id),
      REQUIRED_REPRESENTATIVE_SCENARIOS,
    );
    for (const scenario of parsed.scenarios) {
      assert.ok(scenario.artifactRefs.length > 0, `${scenario.id} needs artifacts`);
      assert.ok(scenario.requiredEvidence.length > 0, `${scenario.id} needs evidence`);
      assert.ok(scenario.safeOutcome.length > 0, `${scenario.id} needs safe outcome`);
    }
  });

  it("summarizes launch readiness without claiming full audit execution", () => {
    const parsed = parseVibeRepresentativeA11yUsabilityChecks(
      VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS,
    );
    const summary = summarizeArtifactReadiness(parsed);

    assert.equal(summary.length, REQUIRED_REPRESENTATIVE_ARTIFACTS.length);
    assert.ok(summary.every((entry) => entry.requiredChecks === REQUIRED_REPRESENTATIVE_CHECKS.length));
    assert.ok(summary.some((entry) => entry.highestSeverity === "launch-blocker"));
    assert.ok(summary.every((entry) => !entry.claimsFullAudit));
  });

  it("rejects drift that removes a required artifact, check, source, or proof mode", () => {
    assert.throws(
      () =>
        parseVibeRepresentativeA11yUsabilityChecks({
          ...VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS,
          artifactChecks: VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS.artifactChecks.filter(
            (artifact) => artifact.artifact !== "launch-demo",
          ),
        }),
      VibeRepresentativeChecksParseError,
    );

    assert.throws(
      () =>
        parseVibeRepresentativeA11yUsabilityChecks({
          ...VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS,
          checkDefinitions: VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS.checkDefinitions.filter(
            (check) => check.id !== "screen-reader-smoke",
          ),
        }),
      VibeRepresentativeChecksParseError,
    );

    assert.throws(
      () =>
        parseVibeRepresentativeA11yUsabilityChecks({
          ...VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS,
          sourceIssues: ["HOBO-577"] as never,
        }),
      VibeRepresentativeChecksParseError,
    );

    assert.throws(
      () =>
        parseVibeRepresentativeA11yUsabilityChecks({
          ...VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS,
          proofModeLabels: ["live"] as never,
        }),
      VibeRepresentativeChecksParseError,
    );
  });

  it("fails closed for adversarial scope-out requests", () => {
    assert.deepEqual(
      [
        "run a full accessibility audit and certify launch",
        "remediate product UI defects across every screen",
        "build an automated accessibility test suite",
        "approve the launch waiver for contrast failures",
        "attach real customer screenshots as evidence",
        "publish a launch claim without evidence",
      ].map(classifyRepresentativeCheckRequest),
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
      classifyRepresentativeCheckRequest("add representative keyboard evidence for the onboarding artifact"),
      "in-scope-proof",
    );
  });

  it("returns structured validation errors for incomplete fixture metadata", () => {
    const validation = validateVibeRepresentativeA11yUsabilityChecks({
      ...VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS,
      artifactChecks: VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS.artifactChecks.map((artifact) =>
        artifact.artifact === "docs"
          ? {
              ...artifact,
              checks: artifact.checks.map((check) =>
                check.checkId === "copy-clarity"
                  ? {
                      ...check,
                      expectedEvidence: "",
                    }
                  : check,
              ),
            }
          : artifact,
      ),
    });

    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((error) => error.code === "missing-check-evidence"));
  });

  it("keeps Pact and CUE boundary artifacts aligned with parsed representative checks", () => {
    const pact = JSON.parse(
      readFileSync(
        new URL(
          "../architecture/pacts/vibe_representative_a11y_usability_checks.pact.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly interactions: ReadonlyArray<{
        readonly response: { readonly body: unknown };
      }>;
    };

    const parsed = parseVibeRepresentativeA11yUsabilityChecks(
      pact.interactions[0].response.body as typeof VIBE_REPRESENTATIVE_A11Y_USABILITY_CHECKS,
    );
    assert.deepEqual(
      parsed.artifactChecks.map((artifact) => artifact.artifact),
      REQUIRED_REPRESENTATIVE_ARTIFACTS,
    );
    assert.deepEqual(
      parsed.checkDefinitions.map((check) => check.id),
      REQUIRED_REPRESENTATIVE_CHECKS,
    );

    const cue = readFileSync(
      new URL("../architecture/vibe_representative_a11y_usability_checks.cue", import.meta.url),
      "utf8",
    );
    for (const field of [
      "artifactChecks",
      "checkDefinitions",
      "expectedEvidence",
      "severity",
      "ownerRoute",
      "acceptedRiskPath",
      "launchReadinessImpact",
      "quickstartFixtureRefs",
      "proofModeLabels",
    ]) {
      assert.match(cue, new RegExp(`\\b${field}\\b`));
    }
  });
});
