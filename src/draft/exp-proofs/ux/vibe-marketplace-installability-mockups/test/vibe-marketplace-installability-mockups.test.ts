import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  REQUIRED_MARKETPLACE_FIXTURE_STATES,
  REQUIRED_MARKETPLACE_PERSONAS,
  REQUIRED_MARKETPLACE_PROOF_MODES,
  REQUIRED_MARKETPLACE_SCENARIOS,
  REQUIRED_MARKETPLACE_SURFACES,
  REQUIRED_QUICKSTART_FIXTURE_IDS,
  VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS,
  VibeMarketplaceInstallabilityMockupsParseError,
  classifyMarketplaceMockupRequest,
  parseVibeMarketplaceInstallabilityMockups,
  renderInstallabilitySummary,
  validateVibeMarketplaceInstallabilityMockups,
} from "../src/vibe-marketplace-installability-mockups.ts";

test("HOBO-546 pins issue, target paths, personas, surfaces, and fixture states", () => {
  const parsed = parseVibeMarketplaceInstallabilityMockups(
    VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS,
  );

  assert.equal(parsed.issue, "HOBO-546");
  assert.equal(parsed.phase, "M1");
  assert.equal(
    parsed.packagePath,
    "src/draft/exp-proofs/ux/vibe-marketplace-installability-mockups",
  );
  assert.equal(
    parsed.proofPath,
    "docs/design/proofs/vibe-marketplace-installability-mockups/README.md",
  );
  assert.deepEqual(parsed.personas, REQUIRED_MARKETPLACE_PERSONAS);
  assert.deepEqual(
    parsed.wireframes.map((wireframe) => wireframe.surface),
    REQUIRED_MARKETPLACE_SURFACES,
  );
  assert.deepEqual(
    parsed.fixtures.map((fixture) => fixture.state),
    REQUIRED_MARKETPLACE_FIXTURE_STATES,
  );
});

test("wireframes cover each persona with concrete operating questions", () => {
  const parsed = parseVibeMarketplaceInstallabilityMockups(
    VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS,
  );

  for (const persona of REQUIRED_MARKETPLACE_PERSONAS) {
    const personaWireframes = parsed.wireframes.filter((wireframe) =>
      wireframe.personas.includes(persona),
    );

    assert.ok(personaWireframes.length > 0, `${persona} needs a wireframe`);
    assert.ok(
      personaWireframes.some((wireframe) =>
        wireframe.questionsAnswered.some((question) => question.length > 20),
      ),
      `${persona} needs a concrete question`,
    );
  }
});

test("listing fixtures carry visible state, evidence source, owner route, customer message, org-catalog disposition, and proof mode", () => {
  const parsed = parseVibeMarketplaceInstallabilityMockups(
    VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS,
  );

  for (const fixture of parsed.fixtures) {
    assert.ok(fixture.visibleState.length > 0);
    assert.ok(fixture.evidenceSource.length > 0);
    assert.ok(fixture.ownerRoute.length > 0);
    assert.ok(fixture.customerSafeMessage.length > 0);
    assert.ok(fixture.orgCatalogDisposition.length > 0);
    assert.ok(REQUIRED_MARKETPLACE_PROOF_MODES.includes(fixture.proofMode));
    assert.match(renderInstallabilitySummary(fixture), new RegExp(fixture.state));
  }
});

test("scenario paths cover happy, blocked, stale or unknown evidence, support handoff, accessibility, and proof modes", () => {
  const parsed = parseVibeMarketplaceInstallabilityMockups(
    VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS,
  );

  assert.deepEqual(
    parsed.scenarioPaths.map((scenario) => scenario.id),
    REQUIRED_MARKETPLACE_SCENARIOS,
  );

  const pathModes = new Set(parsed.scenarioPaths.flatMap((scenario) => scenario.proofModeLabels));
  for (const mode of REQUIRED_MARKETPLACE_PROOF_MODES) {
    assert.ok(pathModes.has(mode), `missing proof mode ${mode}`);
  }

  const accessibilityText = parsed.accessibilityNotes.join(" ").toLowerCase();
  for (const requirement of ["keyboard", "screen reader", "contrast", "responsive", "motion"]) {
    assert.match(accessibilityText, new RegExp(requirement));
  }
});

test("mockups cite accepted HOBO-577 quickstart fixture ids", () => {
  const parsed = parseVibeMarketplaceInstallabilityMockups(
    VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS,
  );

  assert.deepEqual(
    parsed.quickstartFixtureRefs.map((ref) => ref.fixtureId),
    REQUIRED_QUICKSTART_FIXTURE_IDS,
  );
  assert.ok(parsed.quickstartFixtureRefs.every((ref) => ref.sourceIssue === "HOBO-577"));
});

test("architecture Pact and CUE fixtures align with the parsed proof", () => {
  // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
  const pact = JSON.parse(
    readFileSync(
      new URL(
        "../architecture/pacts/vibe_marketplace_installability_mockups.pact.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    readonly interactions: ReadonlyArray<{
      readonly response: { readonly body: unknown };
    }>;
  };

  const pactProof = parseVibeMarketplaceInstallabilityMockups(
    pact.interactions[0].response.body,
  );
  assert.deepEqual(
    pactProof.fixtures.map((fixture) => fixture.state),
    REQUIRED_MARKETPLACE_FIXTURE_STATES,
  );

  const cue = readFileSync(
    new URL("../architecture/vibe_marketplace_installability_mockups.cue", import.meta.url),
    "utf8",
  );
  for (const field of [
    "visibleState",
    "evidenceSource",
    "ownerRoute",
    "customerSafeMessage",
    "orgCatalogDisposition",
    "proofMode",
    "scenarioPaths",
    "accessibilityNotes",
  ]) {
    assert.match(cue, new RegExp(`\\b${field}\\b`));
  }
});

test("scope-out requests fail closed instead of becoming marketplace implementation work", () => {
  const classifications = [
    "build the live storefront",
    "implement the registry storage resolver",
    "ship install runtime",
    "rank listings by paid placement",
    "wire publisher portal submission",
    "connect the policy engine and RBAC runtime",
    "announce launch readiness without evidence",
  ].map(classifyMarketplaceMockupRequest);

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
    classifyMarketplaceMockupRequest("add a reference fixture for yanked listing support wording"),
    "in-scope-proof",
  );
});

test("parser rejects missing acceptance metadata and disconnected fixtures", () => {
  assert.throws(
    () =>
      parseVibeMarketplaceInstallabilityMockups({
        ...VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS,
        fixtures: [
          {
            ...VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS.fixtures[0],
            customerSafeMessage: "",
          },
          ...VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS.fixtures.slice(1),
        ],
      }),
    VibeMarketplaceInstallabilityMockupsParseError,
  );

  assert.throws(
    () =>
      parseVibeMarketplaceInstallabilityMockups({
        ...VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS,
        scenarioPaths: [
          {
            ...VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS.scenarioPaths[0],
            fixtureIds: ["missing-fixture"],
          },
          ...VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS.scenarioPaths.slice(1),
        ],
      }),
    VibeMarketplaceInstallabilityMockupsParseError,
  );
});

test("validator reports missing required surfaces", () => {
  const validation = validateVibeMarketplaceInstallabilityMockups({
    ...VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS,
    wireframes: VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS.wireframes.filter(
      (wireframe) => wireframe.surface !== "listing-detail",
    ),
  });

  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.code === "missing-wireframe-surface"));
});
