import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_BOUNDARIES,
  SUPPORT_SLA_CHANNELS_SCOPE,
  canCreateSupportSlaFollowUp,
  canPublishContractualSla,
  classifySupportRequest,
  validateSupportSlaChannelsScope,
} from "../src/support-sla-channels.mjs";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  assert.deepEqual(validateSupportSlaChannelsScope(SUPPORT_SLA_CHANNELS_SCOPE), {
    ok: true,
    errors: [],
  });
  assert.equal(SUPPORT_SLA_CHANNELS_SCOPE.issue, "HOBO-496");
  assert.equal(SUPPORT_SLA_CHANNELS_SCOPE.project, "Support Workflow");
  assert.equal(SUPPORT_SLA_CHANNELS_SCOPE.phase, "M0");
  assert.match(SUPPORT_SLA_CHANNELS_SCOPE.goal, /support/i);
  assert.match(SUPPORT_SLA_CHANNELS_SCOPE.goal, /sla/i);
  assert.deepEqual(
    SUPPORT_SLA_CHANNELS_SCOPE.personas.map((persona) => persona.id),
    [
      "support-lead",
      "support-operator",
      "customer-admin",
      "incident-commander",
      "release-owner",
      "security-compliance-reviewer",
    ],
  );
  assert.deepEqual(
    SUPPORT_SLA_CHANNELS_SCOPE.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.ok(SUPPORT_SLA_CHANNELS_SCOPE.scopeOut.some((item) => /contractual sla approval/i.test(item)));
});

test("support model defines channels, hours, response targets, severity routing, handoffs, and unsupported classes", () => {
  assert.deepEqual(
    SUPPORT_SLA_CHANNELS_SCOPE.channels.map((channel) => channel.id),
    ["support-ticket", "status-page", "launch-room", "customer-email", "docs-faq"],
  );
  assert.deepEqual(
    SUPPORT_SLA_CHANNELS_SCOPE.responseTargets.map((target) => target.severity),
    ["sev0", "sev1", "sev2", "sev3"],
  );
  assert.equal(
    SUPPORT_SLA_CHANNELS_SCOPE.responseTargets.every(
      (target) => target.internalTarget && target.betaPromise && target.handoffRule,
    ),
    true,
  );
  assert.ok(SUPPORT_SLA_CHANNELS_SCOPE.unsupportedRequestClasses.length >= 5);
});

test("SLA language separates internal targets, beta promises, and GA commitments", () => {
  assert.deepEqual(
    SUPPORT_SLA_CHANNELS_SCOPE.slaLanguage.map((entry) => entry.mode),
    ["internal-target", "beta-promise", "ga-customer-commitment"],
  );
  assert.equal(SUPPORT_SLA_CHANNELS_SCOPE.slaLanguage[0].customerFacing, false);
  assert.equal(SUPPORT_SLA_CHANNELS_SCOPE.slaLanguage[1].contractual, false);
  assert.equal(SUPPORT_SLA_CHANNELS_SCOPE.slaLanguage[2].requiresBusinessOwnerApproval, true);
});

test("escalation links support, incident communications, admin console, and release cutline decisions", () => {
  assert.deepEqual(
    SUPPORT_SLA_CHANNELS_SCOPE.escalationLinks.map((link) => link.owner),
    [
      "Support Workflow",
      "Incident Communications",
      "Admin Console",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    SUPPORT_SLA_CHANNELS_SCOPE.escalationLinks.every(
      (link) => link.source && link.consumes && link.boundary,
    ),
    true,
  );
});

test("M1-M4 follow-up issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateSupportSlaFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateSupportSlaFollowUp({ phase: "M3", m0Accepted: false }).allowed, false);
  assert.equal(canCreateSupportSlaFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateSupportSlaFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("contractual SLA publication requires business-owner signoff and accepted evidence", () => {
  assert.equal(
    canPublishContractualSla({
      mode: "ga-customer-commitment",
      businessOwnerApproved: false,
      evidenceAccepted: true,
    }).allowed,
    false,
  );
  assert.equal(
    canPublishContractualSla({
      mode: "ga-customer-commitment",
      businessOwnerApproved: true,
      evidenceAccepted: false,
    }).allowed,
    false,
  );
  assert.equal(
    canPublishContractualSla({
      mode: "ga-customer-commitment",
      businessOwnerApproved: true,
      evidenceAccepted: true,
    }).allowed,
    true,
  );
});

test("validation rejects contractual SLA approval or support tooling scope creep", () => {
  const result = validateSupportSlaChannelsScope({
    ...SUPPORT_SLA_CHANNELS_SCOPE,
    scopeIn: [
      ...SUPPORT_SLA_CHANNELS_SCOPE.scopeIn,
      "Approve contractual SLA language and build support ticket automation in this slice.",
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("request classifier routes unsupported and adjacent work to owning lanes", () => {
  assert.deepEqual(classifySupportRequest("define beta support channel coverage"), {
    owner: "Support Workflow",
    inScope: true,
  });
  assert.equal(
    classifySupportRequest("approve contractual SLA terms for enterprise plan").owner,
    "Business Owner / Legal",
  );
  assert.equal(
    classifySupportRequest("debug admin console tenant visibility").owner,
    "Admin Console",
  );
  assert.equal(
    classifySupportRequest("public incident communication status page wording").owner,
    "Incident Communications",
  );
  assert.equal(
    classifySupportRequest("release cutline exception for unsupported support hours").owner,
    "V1 Release Program & Cutline",
  );
});
