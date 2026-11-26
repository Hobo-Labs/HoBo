import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  MARKETPLACE_ACCESSIBILITY_CHECKS,
  MARKETPLACE_PROOF_MODES,
  MARKETPLACE_TRUST_COPY_SCENARIOS,
  MARKETPLACE_TRUST_COPY_STATES,
  REQUIRED_MARKETPLACE_COPY_SCENARIOS,
  REQUIRED_MARKETPLACE_TRUST_QUICKSTART_FIXTURE_IDS,
  REQUIRED_MARKETPLACE_TRUST_QUICKSTART_PROOF_MODES,
  classifyMarketplaceCopyClaim,
  listMarketplaceTrustCopyScenarios,
  parseMarketplaceTrustCopyStates,
  summarizeMarketplaceTrustHandoffs,
} from "../src/vibe-marketplace-trust-copy-states.ts";

describe("vibe marketplace trust copy states", () => {
  it("pins the HOBO-547 package, proof note, design refs, and required copy scenarios", () => {
    const proof = parseMarketplaceTrustCopyStates(MARKETPLACE_TRUST_COPY_STATES);

    assert.equal(proof.issue, "HOBO-547");
    assert.equal(
      proof.targetPackage,
      "src/draft/exp-proofs/ux/vibe-marketplace-trust-copy-states",
    );
    assert.equal(
      proof.proofNote,
      "docs/design/proofs/vibe-marketplace-trust-copy-states/README.md",
    );
    assert.deepEqual(
      proof.scenarios.map((scenario) => scenario.kind),
      REQUIRED_MARKETPLACE_COPY_SCENARIOS,
    );
    assert.ok(proof.designRefs.includes("docs/design/marketplace-ux.md"));
    assert.ok(proof.designRefs.includes("docs/design/org-catalogs.md"));
  });

  it("cites accepted HOBO-577 quickstart fixture ids and proof-mode labels", () => {
    const proof = parseMarketplaceTrustCopyStates(MARKETPLACE_TRUST_COPY_STATES);

    assert.deepEqual(
      proof.quickstartFixtureRefs.map((ref) => ref.fixtureId),
      REQUIRED_MARKETPLACE_TRUST_QUICKSTART_FIXTURE_IDS,
    );
    assert.ok(proof.quickstartFixtureRefs.every((ref) => ref.sourceIssue === "HOBO-577"));
    assert.deepEqual(
      [...new Set(proof.quickstartFixtureRefs.map((ref) => ref.proofMode))],
      REQUIRED_MARKETPLACE_TRUST_QUICKSTART_PROOF_MODES,
    );

    const coveredCopyStates = new Set(proof.quickstartFixtureRefs.flatMap((ref) => ref.copyStates));
    for (const scenario of REQUIRED_MARKETPLACE_COPY_SCENARIOS) {
      assert.ok(coveredCopyStates.has(scenario), `expected HOBO-577 ref for ${scenario}`);
    }
    assert.ok(proof.quickstartFixtureRefs.every((ref) => ref.trustCopyUse.length > 30));
  });

  it("makes each fixture carry owner, evidence, customer-safe copy, proof mode, and accessibility notes", () => {
    const proof = parseMarketplaceTrustCopyStates(MARKETPLACE_TRUST_COPY_STATES);
    const scenarios = listMarketplaceTrustCopyScenarios(proof);

    assert.equal(scenarios.length, REQUIRED_MARKETPLACE_COPY_SCENARIOS.length);

    for (const scenario of scenarios) {
      assert.match(scenario.fixtureId, /^mtc-[a-z0-9-]+-v[0-9]+$/);
      assert.ok(MARKETPLACE_PROOF_MODES.includes(scenario.proofMode));
      assert.equal(classifyMarketplaceCopyClaim(scenario.copy.headline).allowed, true);
      assert.equal(classifyMarketplaceCopyClaim(scenario.copy.body).allowed, true);
      assert.equal(classifyMarketplaceCopyClaim(scenario.copy.nextAction).allowed, true);
      assert.ok(scenario.ownerRoute.length > 0);
      assert.ok(scenario.evidenceSource.length > 0);
      assert.deepEqual(
        scenario.accessibilityNotes.map((note) => note.check),
        MARKETPLACE_ACCESSIBILITY_CHECKS,
      );
    }
  });

  it("rejects copy that overstates security, popularity, installability, registry guarantees, or support readiness", () => {
    assert.deepEqual(classifyMarketplaceCopyClaim("Verified secure for production"), {
      allowed: false,
      reason: "security-overclaim",
    });
    assert.deepEqual(classifyMarketplaceCopyClaim("Most popular provider pack"), {
      allowed: false,
      reason: "popularity-overclaim",
    });
    assert.deepEqual(classifyMarketplaceCopyClaim("Safe to install now"), {
      allowed: false,
      reason: "installability-overclaim",
    });
    assert.deepEqual(classifyMarketplaceCopyClaim("Registry guarantees this artifact"), {
      allowed: false,
      reason: "registry-guarantee",
    });
    assert.deepEqual(classifyMarketplaceCopyClaim("Fully supported with 24/7 helpdesk"), {
      allowed: false,
      reason: "support-readiness-overclaim",
    });
  });

  it("covers happy, blocked, stale or unknown evidence, support handoff, and every proof-mode label", () => {
    const proof = parseMarketplaceTrustCopyStates(MARKETPLACE_TRUST_COPY_STATES);
    const modes = new Set(proof.scenarios.map((scenario) => scenario.proofMode));
    const paths = new Set(proof.scenarios.map((scenario) => scenario.path));

    for (const mode of MARKETPLACE_PROOF_MODES) {
      assert.ok(modes.has(mode), `expected proof mode ${mode}`);
    }

    assert.ok(paths.has("happy"));
    assert.ok(paths.has("blocked"));
    assert.ok(paths.has("stale-or-unknown"));
    assert.ok(paths.has("support-handoff"));
    assert.ok(proof.scopeOut.some((entry) => entry.includes("production UI")));
  });

  it("summarizes handoffs without taking publisher portal, policy, notification, or support queue scope", () => {
    const proof = parseMarketplaceTrustCopyStates(MARKETPLACE_TRUST_COPY_STATES);
    const handoffs = summarizeMarketplaceTrustHandoffs(proof);

    assert.deepEqual(
      handoffs.map((handoff) => handoff.owner),
      [
        "Marketplace UX",
        "Capability Review & Approval",
        "Marketplace Publisher Trust Evidence",
        "Org Catalogs",
        "Registry Distribution",
        "Support Workflow",
        "Accessibility & Usability Quality",
      ],
    );
    assert.ok(handoffs.every((handoff) => handoff.mustNotOwn.length > 0));
  });

  it("fails closed when required scenarios, evidence, support handoff, or scope boundaries drift", () => {
    assert.throws(
      () =>
        parseMarketplaceTrustCopyStates({
          ...MARKETPLACE_TRUST_COPY_STATES,
          scenarios: MARKETPLACE_TRUST_COPY_SCENARIOS.filter(
            (scenario) => scenario.kind !== "yanked-support-route",
          ),
        }),
      /missing marketplace copy scenario yanked-support-route/,
    );

    assert.throws(
      () =>
        parseMarketplaceTrustCopyStates({
          ...MARKETPLACE_TRUST_COPY_STATES,
          scenarios: MARKETPLACE_TRUST_COPY_SCENARIOS.map((scenario) =>
            scenario.kind === "installable-with-evidence"
              ? { ...scenario, evidenceSource: "" }
              : scenario,
          ),
        }),
      /evidenceSource must not be empty/,
    );

    assert.throws(
      () =>
        parseMarketplaceTrustCopyStates({
          ...MARKETPLACE_TRUST_COPY_STATES,
          scopeOut: ["Build production UI, policy engine, support queue, and publisher portal."],
        }),
      /scopeOut missing/,
    );

    assert.throws(
      () =>
        parseMarketplaceTrustCopyStates({
          ...MARKETPLACE_TRUST_COPY_STATES,
          quickstartFixtureRefs: MARKETPLACE_TRUST_COPY_STATES.quickstartFixtureRefs.filter(
            (ref) => ref.fixtureId !== "rlq-manage-stale-evidence-v1",
          ),
        }),
      /required HOBO-577 fixture ids/,
    );

    assert.throws(
      () =>
        parseMarketplaceTrustCopyStates({
          ...MARKETPLACE_TRUST_COPY_STATES,
          quickstartFixtureRefs: [
            {
              ...MARKETPLACE_TRUST_COPY_STATES.quickstartFixtureRefs[0],
              sourceIssue: "HOBO-546",
            },
            ...MARKETPLACE_TRUST_COPY_STATES.quickstartFixtureRefs.slice(1),
          ],
        }),
      /sourceIssue/,
    );
  });

  it("keeps Pact and CUE boundary artifacts aligned with the parsed proof shape", () => {
    // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
    const pact = JSON.parse(
      readFileSync(
        new URL(
          "../architecture/pacts/vibe_marketplace_trust_copy_states.pact.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly interactions: ReadonlyArray<{
        readonly response: { readonly body: unknown };
      }>;
    };

    const pactProof = parseMarketplaceTrustCopyStates(pact.interactions[0].response.body);
    assert.deepEqual(
      pactProof.scenarios.map((scenario) => scenario.kind),
      REQUIRED_MARKETPLACE_COPY_SCENARIOS,
    );
    assert.deepEqual(
      pactProof.quickstartFixtureRefs,
      MARKETPLACE_TRUST_COPY_STATES.quickstartFixtureRefs,
    );

    const cue = readFileSync(
      new URL("../architecture/vibe_marketplace_trust_copy_states.cue", import.meta.url),
      "utf8",
    );
    for (const field of [
      "targetPackage",
      "proofNote",
      "fixtureId",
      "proofMode",
      "ownerRoute",
      "evidenceSource",
      "accessibilityNotes",
      "safeClaim",
      "mustNotOwn",
      "quickstartFixtureRefs",
      "sourceIssue",
      "trustCopyUse",
    ]) {
      assert.match(cue, new RegExp(`\\b${field}\\b`));
    }
  });
});
