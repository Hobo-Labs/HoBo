import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  REQUIRED_DASHBOARD_COVERAGE_PATHS,
  REQUIRED_DASHBOARD_FIXTURE_FIELDS,
  REQUIRED_DASHBOARD_PROOF_MODES,
  REQUIRED_DASHBOARD_READ_STATES,
  VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES,
  classifyDashboardFixtureScope,
  parseDashboardFreshnessRbacFixtures,
  renderDashboardFixtureSummary,
  renderSupportHandoffPacket,
} from "../src/vibe-dashboard-freshness-rbac-fixtures.ts";

describe("HOBO-545 dashboard freshness/RBAC fixtures", () => {
  it("pins the issue, package path, proof note, and required read states", () => {
    const proof = parseDashboardFreshnessRbacFixtures(
      VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES,
    );

    assert.equal(proof.issue, "HOBO-545");
    assert.equal(proof.phase, "M1");
    assert.equal(
      proof.targetPackage,
      "src/draft/exp-proofs/ux/vibe-dashboard-freshness-rbac-fixtures",
    );
    assert.equal(
      proof.proofNote,
      "docs/design/proofs/vibe-dashboard-freshness-rbac-fixtures/README.md",
    );
    assert.deepEqual(
      proof.fixtures.map((fixture) => fixture.state),
      REQUIRED_DASHBOARD_READ_STATES,
    );
    assert.deepEqual(proof.proofModeLabels, REQUIRED_DASHBOARD_PROOF_MODES);
    assert.deepEqual(
      proof.coveragePaths.map((path) => path.id),
      REQUIRED_DASHBOARD_COVERAGE_PATHS,
    );
    assert.ok(proof.accessibilityNotes.length > 0);
  });

  it("each fixture carries accepted projection, tenant/RBAC, owner, evidence, wording, and next-action fields", () => {
    const proof = parseDashboardFreshnessRbacFixtures(
      VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES,
    );

    for (const fixture of proof.fixtures) {
      for (const field of REQUIRED_DASHBOARD_FIXTURE_FIELDS) {
        assert.ok(fixture[field], `${fixture.state} missing ${field}`);
      }
      assert.match(fixture.projectionSource, /View$/);
      assert.equal(fixture.scope.tenantFirst, true);
      assert.ok(fixture.scope.tenant.length > 0);
      assert.ok(fixture.scope.project.length > 0);
      assert.ok(fixture.scope.environment.length > 0);
      assert.ok(fixture.owner.actor.length > 0);
      assert.ok(fixture.evidenceLink.startsWith("proof://hobo-545/"));
      assert.ok(fixture.customerSafeWording.length > 0);
      assert.ok(fixture.nextAction.length > 0);
      assert.ok(REQUIRED_DASHBOARD_PROOF_MODES.includes(fixture.proofMode));
    }
  });

  it("covers happy, blocked, stale or unknown evidence, support handoff, accessibility, and proof-mode labels", () => {
    const proof = parseDashboardFreshnessRbacFixtures(
      VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES,
    );
    const fixtureIds = new Set(proof.fixtures.map((fixture) => fixture.fixtureId));

    for (const path of proof.coveragePaths) {
      assert.ok(path.fixtureIds.every((fixtureId) => fixtureIds.has(fixtureId)));
      assert.ok(path.accessibilityNote.length > 0);
      assert.ok(path.safeOutcome.length > 0);
      assert.ok(path.proofModeLabels.every((mode) => REQUIRED_DASHBOARD_PROOF_MODES.includes(mode)));
    }

    const pathModes = new Set(proof.coveragePaths.flatMap((path) => path.proofModeLabels));
    for (const mode of REQUIRED_DASHBOARD_PROOF_MODES) {
      assert.ok(pathModes.has(mode), `missing proof mode ${mode}`);
    }

    const accessibilityText = proof.accessibilityNotes.join(" ").toLowerCase();
    for (const requiredNote of ["screen reader", "color", "keyboard"]) {
      assert.match(accessibilityText, new RegExp(requiredNote));
    }
  });

  it("renders dashboard summaries and support handoff packets without leaking withheld fields", () => {
    const proof = parseDashboardFreshnessRbacFixtures(
      VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES,
    );

    for (const fixture of proof.fixtures) {
      const summary = renderDashboardFixtureSummary(fixture);
      const handoff = renderSupportHandoffPacket(fixture);

      assert.match(summary, new RegExp(fixture.state));
      assert.match(summary, /proof mode: reference fixture/);
      assert.match(handoff.customerSafeWording, /No customer payloads or provider credentials/);
      assert.ok(handoff.visibleFields.includes("tenant"));
      assert.ok(handoff.visibleFields.includes("correlationId"));
      assert.ok(handoff.withheldFields.includes("rawProjectionPayload"));
      assert.ok(handoff.withheldFields.includes("providerCredential"));
    }
  });

  it("aligns Pact and CUE architecture fixtures with the parsed proof", () => {
    // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
    const pact = JSON.parse(
      readFileSync(
        new URL(
          "../architecture/pacts/vibe_dashboard_freshness_rbac_fixtures.pact.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly interactions: ReadonlyArray<{
        readonly response: { readonly body: unknown };
      }>;
    };

    const pactProof = parseDashboardFreshnessRbacFixtures(
      pact.interactions[0].response.body,
    );
    assert.deepEqual(
      pactProof.fixtures.map((fixture) => fixture.state),
      REQUIRED_DASHBOARD_READ_STATES,
    );

    const cue = readFileSync(
      new URL(
        "../architecture/vibe_dashboard_freshness_rbac_fixtures.cue",
        import.meta.url,
      ),
      "utf8",
    );
    for (const field of [
      "projectionSource",
      "tenantFirst",
      "actor",
      "evidenceLink",
      "customerSafeWording",
      "nextAction",
      "proofMode",
      "proofModeLabels",
      "coveragePaths",
      "accessibilityNotes",
    ]) {
      assert.match(cue, new RegExp(`\\b${field}\\b`));
    }
  });

  it("rejects authorization, redaction, read-store, live support, production UI, and launch-claim creep", () => {
    assert.deepEqual(classifyDashboardFixtureScope("Implement the authorization engine"), {
      allowed: false,
      reason: "authorization-engine",
    });
    assert.deepEqual(classifyDashboardFixtureScope("Build the redaction runtime"), {
      allowed: false,
      reason: "redaction-runtime",
    });
    assert.deepEqual(classifyDashboardFixtureScope("Ship the read-store implementation"), {
      allowed: false,
      reason: "read-store-runtime",
    });
    assert.deepEqual(classifyDashboardFixtureScope("Wire live support tooling"), {
      allowed: false,
      reason: "live-support-tooling",
    });
    assert.deepEqual(classifyDashboardFixtureScope("Build production dashboard UI"), {
      allowed: false,
      reason: "production-ui",
    });
    assert.deepEqual(classifyDashboardFixtureScope("Publish launch claims from this proof"), {
      allowed: false,
      reason: "launch-claim",
    });
    assert.deepEqual(
      classifyDashboardFixtureScope("Add deterministic projection freshness reference fixtures"),
      { allowed: true, reason: "reference-fixture" },
    );
  });

  it("fails closed if acceptance evidence is removed or disconnected", () => {
    assert.throws(
      () =>
        parseDashboardFreshnessRbacFixtures({
          ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES,
          accessibilityNotes: ["Screen reader labels exist.", "Keyboard handoff exists."],
        }),
      /color/,
    );

    assert.throws(
      () =>
        parseDashboardFreshnessRbacFixtures({
          ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES,
          proofModeLabels: ["reference fixture"],
        }),
      /proofModeLabels/,
    );

    assert.throws(
      () =>
        parseDashboardFreshnessRbacFixtures({
          ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES,
          coveragePaths: [
            {
              ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES.coveragePaths[0],
              proofModeLabels: [],
            },
            ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES.coveragePaths.slice(1),
          ],
        }),
      /proof-mode/,
    );

    assert.throws(
      () =>
        parseDashboardFreshnessRbacFixtures({
          ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES,
          coveragePaths: [
            {
              ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES.coveragePaths[0],
              fixtureIds: ["missing-fixture"],
            },
            ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES.coveragePaths.slice(1),
          ],
        }),
      /unknown fixture/,
    );

    assert.throws(
      () =>
        parseDashboardFreshnessRbacFixtures({
          ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES,
          fixtures: [
            {
              ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES.fixtures[0],
              scope: {
                ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES.fixtures[0].scope,
                tenantFirst: false,
              },
            },
            ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES.fixtures.slice(1),
          ],
        }),
      /tenant-first/,
    );

    assert.throws(
      () =>
        parseDashboardFreshnessRbacFixtures({
          ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES,
          fixtures: [
            {
              ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES.fixtures[0],
              redaction: {
                ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES.fixtures[0].redaction,
                withheldFields: [],
              },
            },
            ...VIBE_DASHBOARD_FRESHNESS_RBAC_FIXTURES.fixtures.slice(1),
          ],
        }),
      /withheld/,
    );
  });
});
