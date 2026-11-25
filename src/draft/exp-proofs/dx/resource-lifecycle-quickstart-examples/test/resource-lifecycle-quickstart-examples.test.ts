import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  QUICKSTART_CHANNELS,
  QUICKSTART_CONSUMERS,
  QUICKSTART_PHASES,
  QUICKSTART_PROOF_MODES,
  RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES,
  classifyQuickstartScope,
  listQuickstartSnippets,
  parseResourceLifecycleQuickstartExamples,
  summarizeQuickstartHandoffs,
} from "../src/resource-lifecycle-quickstart-examples.ts";

describe("resource lifecycle quickstart examples", () => {
  it("pins the HOBO-577 package, proof note, phases, and snippet channels", () => {
    const quickstart = parseResourceLifecycleQuickstartExamples(
      RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES,
    );

    assert.equal(quickstart.issue, "HOBO-577");
    assert.equal(quickstart.targetPackage, "src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples");
    assert.equal(quickstart.proofNote, "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md");
    assert.deepEqual(
      quickstart.steps.map((step) => step.phase),
      QUICKSTART_PHASES,
    );

    for (const step of quickstart.steps) {
      assert.deepEqual(
        QUICKSTART_CHANNELS.map((channel) => step.snippets[channel].channel),
        QUICKSTART_CHANNELS,
      );
    }
  });

  it("makes every docs-ready snippet carry a fixture id, proof-mode label, and safe claim", () => {
    const quickstart = parseResourceLifecycleQuickstartExamples(
      RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES,
    );
    const snippets = listQuickstartSnippets(quickstart);

    assert.equal(snippets.length, QUICKSTART_PHASES.length * QUICKSTART_CHANNELS.length);
    for (const snippet of snippets) {
      assert.match(snippet.fixtureId, /^rlq-[a-z0-9-]+-v[0-9]+$/);
      assert.ok(QUICKSTART_PROOF_MODES.includes(snippet.proofMode));
      assert.equal(classifyQuickstartScope(snippet.safeClaim).allowed, true);
      assert.ok(snippet.text.length > 0);
    }
  });

  it("labels reference, simulated, live, and scope-out parts explicitly", () => {
    const quickstart = parseResourceLifecycleQuickstartExamples(
      RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES,
    );
    const snippetModes = listQuickstartSnippets(quickstart).map((snippet) => snippet.proofMode);
    const noteModes = quickstart.modeNotes.map((note) => note.proofMode);
    const modes = new Set([...snippetModes, ...noteModes]);

    for (const mode of QUICKSTART_PROOF_MODES) {
      assert.ok(modes.has(mode), `expected proof mode ${mode}`);
    }
  });

  it("keeps deploy, manage, migrate, and recover as lifecycle paths instead of a dashboard tour", () => {
    const quickstart = parseResourceLifecycleQuickstartExamples(
      RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES,
    );
    const phases = new Set(quickstart.steps.map((step) => step.phase));

    for (const required of ["deploy", "manage", "migrate", "recover"] as const) {
      assert.ok(phases.has(required), `expected ${required} phase`);
    }
    assert.deepEqual(
      classifyQuickstartScope("Replace the quickstart with an enterprise dashboard feature tour"),
      { allowed: false, reason: "enterprise-dashboard-tour" },
    );
  });

  it("records handoff notes for every downstream consumer", () => {
    const quickstart = parseResourceLifecycleQuickstartExamples(
      RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES,
    );
    const handoffs = summarizeQuickstartHandoffs(quickstart);

    assert.deepEqual(
      handoffs.map((handoff) => handoff.consumer),
      QUICKSTART_CONSUMERS,
    );
    assert.ok(handoffs.every((handoff) => handoff.fixtureIds.length > 0));
    assert.ok(handoffs.every((handoff) => handoff.mustNotClaim.length > 0));
  });

  it("rejects drift that removes fixtures, phases, consumers, or safe-claim boundaries", () => {
    assert.throws(
      () =>
        parseResourceLifecycleQuickstartExamples({
          ...RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES,
          steps: RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES.steps.filter(
            (step) => step.phase !== "migrate",
          ),
        }),
      /missing quickstart phase migrate/,
    );

    assert.throws(
      () =>
        parseResourceLifecycleQuickstartExamples({
          ...RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES,
          steps: RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES.steps.map((step) =>
            step.phase === "deploy"
              ? {
                  ...step,
                  snippets: {
                    ...step.snippets,
                    cli: {
                      ...step.snippets.cli,
                      fixtureId: "deploy-without-fixture",
                    },
                  },
                }
              : step,
          ),
        }),
      /fixture id/,
    );

    assert.throws(
      () =>
        parseResourceLifecycleQuickstartExamples({
          ...RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES,
          handoffs: RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES.handoffs.filter(
            (handoff) => handoff.consumer !== "Dashboard",
          ),
        }),
      /missing handoff consumer Dashboard/,
    );

    assert.throws(
      () =>
        parseResourceLifecycleQuickstartExamples({
          ...RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES,
          safeClaims: ["Customer promise: production dashboard works with live credentials"],
        }),
      /unsafe quickstart claim/,
    );
  });

  it("keeps Pact and CUE boundary artifacts aligned with the parsed quickstart shape", () => {
    // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
    const pact = JSON.parse(
      readFileSync(
        new URL(
          "../architecture/pacts/resource_lifecycle_quickstart_examples.pact.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly interactions: ReadonlyArray<{
        readonly response: { readonly body: unknown };
      }>;
    };

    const pactQuickstart = parseResourceLifecycleQuickstartExamples(
      pact.interactions[0].response.body,
    );
    assert.deepEqual(
      pactQuickstart.steps.map((step) => step.phase),
      QUICKSTART_PHASES,
    );

    const cue = readFileSync(
      new URL("../architecture/resource_lifecycle_quickstart_examples.cue", import.meta.url),
      "utf8",
    );
    for (const field of [
      "targetPackage",
      "proofNote",
      "safeClaims",
      "modeNotes",
      "proofMode",
      "fixtureId",
      "handoffNote",
      "mustNotClaim",
    ]) {
      assert.match(cue, new RegExp(`\\b${field}\\b`));
    }
    for (const staleField of [
      "target_package",
      "proof_note",
      "safe_claims",
      "mode_notes",
      "proof_mode",
      "fixture_id",
      "handoff_note",
      "must_not_claim",
    ]) {
      assert.doesNotMatch(cue, new RegExp(`\\b${staleField}\\b`));
    }
  });
});
