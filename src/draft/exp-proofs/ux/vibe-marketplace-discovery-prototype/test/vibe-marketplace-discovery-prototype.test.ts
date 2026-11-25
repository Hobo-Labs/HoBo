import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  MARKETPLACE_DISCOVERY_LISTING_STATES,
  MARKETPLACE_DISCOVERY_PATHS,
  MARKETPLACE_DISCOVERY_PROTOTYPE,
  MARKETPLACE_DISCOVERY_PROOF_MODES,
  VibeMarketplaceDiscoveryPrototypeParseError,
  classifyMarketplaceDiscoveryRequest,
  parseMarketplaceDiscoveryPrototype,
  renderMarketplaceInstallIntentSummary,
  validateMarketplaceDiscoveryPrototype,
} from "../src/vibe-marketplace-discovery-prototype.ts";
import { readFileSync } from "node:fs";

describe("vibe marketplace discovery prototype", () => {
  it("pins HOBO-562 target paths and composes the accepted marketplace source issues", () => {
    const proof = parseMarketplaceDiscoveryPrototype(MARKETPLACE_DISCOVERY_PROTOTYPE);

    assert.equal(proof.issue, "HOBO-562");
    assert.equal(proof.phase, "M2");
    assert.equal(
      proof.targetPackage,
      "src/draft/exp-proofs/ux/vibe-marketplace-discovery-prototype",
    );
    assert.equal(
      proof.proofNote,
      "docs/design/proofs/vibe-marketplace-discovery-prototype/README.md",
    );
    assert.deepEqual(
      proof.sourceIssues.map((source) => source.issue),
      ["HOBO-546", "HOBO-547", "HOBO-577"],
    );
    assert.deepEqual(
      proof.catalog.map((fixture) => fixture.listingState),
      MARKETPLACE_DISCOVERY_LISTING_STATES,
    );
  });

  it("fixture catalog carries listing state, trust evidence, org-catalog decision, support route, installability outcome, and proof mode", () => {
    const proof = parseMarketplaceDiscoveryPrototype(MARKETPLACE_DISCOVERY_PROTOTYPE);

    for (const fixture of proof.catalog) {
      assert.ok(fixture.fixtureId.startsWith("mdp-"));
      assert.ok(fixture.displayLabel.length > 0);
      assert.ok(fixture.trustEvidence.length > 0);
      assert.ok(fixture.orgCatalogDecision.length > 0);
      assert.ok(fixture.supportRoute.length > 0);
      assert.ok(fixture.installabilityOutcome.length > 0);
      assert.ok(MARKETPLACE_DISCOVERY_PROOF_MODES.includes(fixture.proofMode));
      assert.match(renderMarketplaceInstallIntentSummary(fixture), new RegExp(fixture.listingState));
    }
  });

  it("links every catalog fixture back to accepted HOBO-546, HOBO-547, and HOBO-577 source fixtures", () => {
    const proof = parseMarketplaceDiscoveryPrototype(MARKETPLACE_DISCOVERY_PROTOTYPE);

    for (const fixture of proof.catalog) {
      assert.equal(fixture.sourceMockup.sourceIssue, "HOBO-546");
      assert.match(fixture.sourceMockup.fixtureId, /^hobo-546-marketplace-/);
      assert.equal(fixture.sourceTrustCopy.sourceIssue, "HOBO-547");
      assert.match(fixture.sourceTrustCopy.fixtureId, /^mtc-[a-z0-9-]+-v1$/);
      assert.equal(fixture.quickstartRef.sourceIssue, "HOBO-577");
      assert.match(fixture.quickstartRef.fixtureId, /^rlq-/);
      assert.ok(fixture.sourceTrustCopy.copyState.length > 0);
      assert.ok(fixture.sourceMockup.surface.length > 0);
    }
  });

  it("covers happy, blocked, stale or unknown evidence, support handoff, accessibility notes, and all proof-mode labels", () => {
    const proof = parseMarketplaceDiscoveryPrototype(MARKETPLACE_DISCOVERY_PROTOTYPE);

    assert.deepEqual(
      proof.paths.map((path) => path.kind),
      MARKETPLACE_DISCOVERY_PATHS,
    );

    const pathModes = new Set(proof.paths.flatMap((path) => path.proofModes));
    for (const mode of MARKETPLACE_DISCOVERY_PROOF_MODES) {
      assert.ok(pathModes.has(mode), `missing proof mode ${mode}`);
    }

    const accessibilityText = proof.accessibilityNotes.join(" ").toLowerCase();
    for (const requirement of [
      "keyboard",
      "screen reader",
      "contrast",
      "responsive",
      "proof mode",
    ]) {
      assert.match(accessibilityText, new RegExp(requirement));
    }
  });

  it("keeps scope-out requests out of the prototype instead of expanding into product implementation", () => {
    const classifications = [
      "build the live storefront",
      "wire registry resolver and install runtime",
      "rank paid marketplace listings",
      "add monetization and payouts",
      "ship publisher workflow",
      "turn this into production UI",
      "wire support queue automation",
      "publish launch claims without evidence",
    ].map(classifyMarketplaceDiscoveryRequest);

    assert.deepEqual(classifications, [
      "scope-out",
      "scope-out",
      "scope-out",
      "scope-out",
      "scope-out",
      "scope-out",
      "scope-out",
      "scope-out",
    ]);
    assert.equal(
      classifyMarketplaceDiscoveryRequest("add deterministic fixture coverage for deprecated listing handoff"),
      "in-scope-proof",
    );
  });

  it("fails closed when metadata, source links, paths, or scope boundaries drift", () => {
    assert.throws(
      () =>
        parseMarketplaceDiscoveryPrototype({
          ...MARKETPLACE_DISCOVERY_PROTOTYPE,
          catalog: [
            {
              ...MARKETPLACE_DISCOVERY_PROTOTYPE.catalog[0],
              trustEvidence: "",
            },
            ...MARKETPLACE_DISCOVERY_PROTOTYPE.catalog.slice(1),
          ],
        }),
      VibeMarketplaceDiscoveryPrototypeParseError,
    );

    assert.throws(
      () =>
        parseMarketplaceDiscoveryPrototype({
          ...MARKETPLACE_DISCOVERY_PROTOTYPE,
          catalog: [
            {
              ...MARKETPLACE_DISCOVERY_PROTOTYPE.catalog[0],
              sourceTrustCopy: {
                ...MARKETPLACE_DISCOVERY_PROTOTYPE.catalog[0].sourceTrustCopy,
                sourceIssue: "HOBO-546",
              },
            },
            ...MARKETPLACE_DISCOVERY_PROTOTYPE.catalog.slice(1),
          ],
        }),
      VibeMarketplaceDiscoveryPrototypeParseError,
    );

    assert.throws(
      () =>
        parseMarketplaceDiscoveryPrototype({
          ...MARKETPLACE_DISCOVERY_PROTOTYPE,
          paths: MARKETPLACE_DISCOVERY_PROTOTYPE.paths.filter(
            (path) => path.kind !== "support-handoff",
          ),
        }),
      VibeMarketplaceDiscoveryPrototypeParseError,
    );

    const validation = validateMarketplaceDiscoveryPrototype({
      ...MARKETPLACE_DISCOVERY_PROTOTYPE,
      scopeOut: ["No production UI only."],
    });
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((error) => error.code === "missing-scope-out"));
  });

  it("keeps Pact and CUE architecture artifacts aligned with the parser", () => {
    // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
    const pact = JSON.parse(
      readFileSync(
        new URL(
          "../architecture/pacts/vibe_marketplace_discovery_prototype.pact.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly interactions: ReadonlyArray<{
        readonly response: { readonly body: unknown };
      }>;
    };

    const pactProof = parseMarketplaceDiscoveryPrototype(pact.interactions[0].response.body);
    assert.deepEqual(
      pactProof.catalog.map((fixture) => fixture.listingState),
      MARKETPLACE_DISCOVERY_LISTING_STATES,
    );

    const cue = readFileSync(
      new URL("../architecture/vibe_marketplace_discovery_prototype.cue", import.meta.url),
      "utf8",
    );
    for (const field of [
      "sourceMockup",
      "sourceTrustCopy",
      "quickstartRef",
      "orgCatalogDecision",
      "installabilityOutcome",
      "supportRoute",
      "proofMode",
      "accessibilityNotes",
      "scopeOut",
    ]) {
      assert.match(cue, new RegExp(`\\b${field}\\b`));
    }
  });
});
