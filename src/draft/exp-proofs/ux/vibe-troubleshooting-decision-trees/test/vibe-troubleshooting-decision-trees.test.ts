import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  REQUIRED_DECISION_TREE_CASES,
  REQUIRED_PROOF_MODES,
  VIBE_TROUBLESHOOTING_DECISION_TREES,
  classifyTroubleshootingScope,
  parseVibeTroubleshootingDecisionTrees,
  renderCustomerSafeGuideEntry,
  renderSupportHandoff,
} from "../src/vibe-troubleshooting-decision-trees.ts";

describe("vibe troubleshooting decision trees", () => {
  it("pins HOBO-553 package, proof note, and required fixture cases", () => {
    const proof = parseVibeTroubleshootingDecisionTrees(
      VIBE_TROUBLESHOOTING_DECISION_TREES,
    );

    assert.equal(proof.issue, "HOBO-553");
    assert.equal(proof.phase, "M1");
    assert.equal(
      proof.targetPackage,
      "src/draft/exp-proofs/ux/vibe-troubleshooting-decision-trees",
    );
    assert.equal(
      proof.proofNote,
      "docs/design/proofs/vibe-troubleshooting-decision-trees/README.md",
    );
    assert.deepEqual(
      proof.cases.map((entry) => entry.caseId),
      REQUIRED_DECISION_TREE_CASES,
    );
  });

  it("covers diagnostic fields, support routing, safe wording, and accessibility notes", () => {
    const proof = parseVibeTroubleshootingDecisionTrees(
      VIBE_TROUBLESHOOTING_DECISION_TREES,
    );

    for (const entry of proof.cases) {
      assert.ok(entry.symptom.length > 0, `${entry.caseId} has symptom`);
      assert.ok(entry.diagnosticEvidence.length > 0, `${entry.caseId} has evidence`);
      assert.ok(entry.owner.length > 0, `${entry.caseId} has owner`);
      assert.ok(entry.safeNextAction.length > 0, `${entry.caseId} has next action`);
      assert.ok(entry.customerSafeWording.length > 0, `${entry.caseId} has safe wording`);
      assert.ok(entry.escalationRoute.length > 0, `${entry.caseId} has escalation route`);
      assert.ok(entry.accessibilityNotes.length > 0, `${entry.caseId} has accessibility notes`);
      assert.ok(
        entry.redaction.withheldFields.length > 0,
        `${entry.caseId} withholds sensitive fields`,
      );
    }
  });

  it("covers happy, blocked, stale/unknown evidence, support handoff, and proof-mode labels", () => {
    const proof = parseVibeTroubleshootingDecisionTrees(
      VIBE_TROUBLESHOOTING_DECISION_TREES,
    );

    assert.ok(proof.cases.some((entry) => entry.pathState === "happy"));
    assert.ok(proof.cases.some((entry) => entry.pathState === "blocked"));
    assert.ok(proof.cases.some((entry) => entry.pathState === "stale-or-unknown"));
    assert.ok(proof.cases.some((entry) => entry.pathState === "support-handoff"));
    assert.deepEqual(proof.proofModes, REQUIRED_PROOF_MODES);
  });

  it("renders guide entries and support handoffs from parsed records only", () => {
    const proof = parseVibeTroubleshootingDecisionTrees(
      VIBE_TROUBLESHOOTING_DECISION_TREES,
    );

    for (const entry of proof.cases) {
      const guide = renderCustomerSafeGuideEntry(entry);
      const handoff = renderSupportHandoff(entry);

      assert.match(guide, new RegExp(entry.owner));
      assert.match(guide, /proof mode:/);
      assert.equal(handoff.caseId, entry.caseId);
      assert.equal(handoff.owner, entry.owner);
      assert.equal(handoff.redaction.redacted, true);
      assert.deepEqual(handoff.visibleFields, entry.redaction.visibleFields);
    }
  });

  it("aligns Pact and CUE architecture fixtures with the parsed proof", () => {
    // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
    const pact = JSON.parse(
      readFileSync(
        new URL(
          "../architecture/pacts/vibe_troubleshooting_decision_trees.pact.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly interactions: ReadonlyArray<{
        readonly response: { readonly body: unknown };
      }>;
    };

    const pactProof = parseVibeTroubleshootingDecisionTrees(
      pact.interactions[0].response.body,
    );
    assert.deepEqual(
      pactProof.cases.map((entry) => entry.caseId),
      REQUIRED_DECISION_TREE_CASES,
    );

    const cue = readFileSync(
      new URL("../architecture/vibe_troubleshooting_decision_trees.cue", import.meta.url),
      "utf8",
    );
    for (const field of [
      "caseId",
      "diagnosticEvidence",
      "customerSafeWording",
      "escalationRoute",
      "accessibilityNotes",
      "proofModes",
      "redaction",
    ]) {
      assert.match(cue, new RegExp(`\\b${field}\\b`));
    }
  });

  it("rejects diagnostic automation, support queues, live repair, customer data, and unsupported claims", () => {
    assert.deepEqual(classifyTroubleshootingScope("Build diagnostic automation"), {
      allowed: false,
      reason: "diagnostic-automation",
    });
    assert.deepEqual(classifyTroubleshootingScope("Create support ticket queue routing"), {
      allowed: false,
      reason: "support-queue",
    });
    assert.deepEqual(classifyTroubleshootingScope("Repair live provider state from the guide"), {
      allowed: false,
      reason: "live-repair",
    });
    assert.deepEqual(classifyTroubleshootingScope("Attach customer data and unredacted logs"), {
      allowed: false,
      reason: "customer-data",
    });
    assert.deepEqual(classifyTroubleshootingScope("Publish launch claims without evidence"), {
      allowed: false,
      reason: "unsupported-launch-claim",
    });
    assert.deepEqual(classifyTroubleshootingScope("Add reference fixture decision tree"), {
      allowed: true,
      reason: "reference-fixture",
    });
  });
});
