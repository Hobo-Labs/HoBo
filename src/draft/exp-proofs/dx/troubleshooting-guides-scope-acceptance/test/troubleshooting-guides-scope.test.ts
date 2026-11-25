import assert from "node:assert/strict";
import { test } from "vitest";

import {
  TROUBLESHOOTING_GUIDES_SCOPE,
  canCreateTroubleshootingFollowUp,
  classifyTroubleshootingHandoff,
  validateTroubleshootingGuidesScope,
} from "../src/troubleshooting-guides-scope.js";

test("M0 scope record states the troubleshooting goal, personas, scope, non-goals, and boundaries", () => {
  const result = validateTroubleshootingGuidesScope(TROUBLESHOOTING_GUIDES_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(TROUBLESHOOTING_GUIDES_SCOPE.issue, "HOBO-437");
  assert.equal(TROUBLESHOOTING_GUIDES_SCOPE.phase, "M0");
  assert.match(TROUBLESHOOTING_GUIDES_SCOPE.goal, /troubleshooting guides/i);
  assert.deepEqual(
    TROUBLESHOOTING_GUIDES_SCOPE.personas.map((persona) => persona.role),
    [
      "first-time app developer",
      "coding agent",
      "support operator",
      "platform engineer",
      "docs maintainer",
    ],
  );
  assert.deepEqual(Object.keys(TROUBLESHOOTING_GUIDES_SCOPE.boundaries), [
    "service",
    "ux",
    "security",
    "support",
  ]);
  assert.ok(TROUBLESHOOTING_GUIDES_SCOPE.scopeIn.length >= 5);
  assert.ok(TROUBLESHOOTING_GUIDES_SCOPE.scopeOut.length >= 5);
  assert.ok(TROUBLESHOOTING_GUIDES_SCOPE.nonGoals.length >= 4);
});

test("M0 scope record maps owning initiative dependencies and design sources", () => {
  assert.deepEqual(
    TROUBLESHOOTING_GUIDES_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/developer-experience.md#plan-07",
      "docs/design/walkthrough.md",
      "docs/design/launch-support-escalation.md",
      "docs/design/support-sla-channels.md",
      "docs/design/incident-communications.md",
      "docs/design/public-status-page-incident-communication.md",
      "docs/design/adr/07-portability-extensibility.md#adr-0064",
    ],
  );

  assert.deepEqual(
    TROUBLESHOOTING_GUIDES_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Troubleshooting Guides",
      "Docs Portal",
      "Support Workflow",
      "V1 Launch Support Desk & Escalation",
      "Incident Communications",
      "Public Status Page",
      "V1 Release Program & Cutline",
    ],
  );
});

test("M1 evidence requirements are explicit and owned", () => {
  assert.deepEqual(
    TROUBLESHOOTING_GUIDES_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "guide-taxonomy",
      "symptom-to-owner-map",
      "safe-action-fixtures",
      "agent-readable-runbook-snippets",
      "security-redaction-rules",
      "support-escalation-handoff",
    ],
  );
  assert.equal(
    TROUBLESHOOTING_GUIDES_SCOPE.m1Evidence.every((evidence) => evidence.owner && evidence.proofMode && evidence.proves),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateTroubleshootingFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateTroubleshootingFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateTroubleshootingFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateTroubleshootingFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("handoff classifier routes adjacent work without expanding troubleshooting scope", () => {
  assert.equal(classifyTroubleshootingHandoff("reset user password for a failed login"), "support-workflow");
  assert.equal(classifyTroubleshootingHandoff("publish outage update for degraded hosted broker"), "incident-communications");
  assert.equal(classifyTroubleshootingHandoff("add dashboard component health field"), "public-status-page");
  assert.equal(classifyTroubleshootingHandoff("document hobo up permission denied symptom"), "troubleshooting-guides");
});

test("scope validation rejects support, runtime, credential, and marketing creep", () => {
  const result = validateTroubleshootingGuidesScope({
    ...TROUBLESHOOTING_GUIDES_SCOPE,
    scopeIn: [
      ...TROUBLESHOOTING_GUIDES_SCOPE.scopeIn,
      "Build the support queue, run production remediation, store provider credentials, and publish marketing docs.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope validation requires proof mode for every troubleshooting claim", () => {
  const result = validateTroubleshootingGuidesScope({
    ...TROUBLESHOOTING_GUIDES_SCOPE,
    m1Evidence: [
      ...TROUBLESHOOTING_GUIDES_SCOPE.m1Evidence,
      {
        kind: "launch-ready-claim",
        owner: "docs maintainer",
        proves: "Troubleshooting guidance is launch ready.",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /proof mode/i);
});
