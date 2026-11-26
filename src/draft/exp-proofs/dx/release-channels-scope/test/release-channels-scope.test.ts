import assert from "node:assert/strict";
import { test } from "vitest";

import {
  RELEASE_CHANNELS_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateReleaseChannelsFollowUp,
  classifyReleaseChannelsDecision,
  validateReleaseChannelsScope,
} from "../src/release-channels-scope.ts";

test("M0 record states goal, personas, scope, non-goals, and boundaries", () => {
  assert.equal(RELEASE_CHANNELS_SCOPE.issue, "HOBO-431");
  assert.equal(RELEASE_CHANNELS_SCOPE.project, "Release Channels");
  assert.equal(RELEASE_CHANNELS_SCOPE.phase, "M0");
  assert.match(RELEASE_CHANNELS_SCOPE.goal, /release channels/i);
  assert.match(RELEASE_CHANNELS_SCOPE.goal, /scope and acceptance/i);
  assert.deepEqual(
    RELEASE_CHANNELS_SCOPE.personas.map((persona) => persona.id),
    ["release-owner", "platform-operator", "application-developer", "support-operator"],
  );
  assert.deepEqual(
    RELEASE_CHANNELS_SCOPE.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.ok(RELEASE_CHANNELS_SCOPE.scopeIn.length >= 5);
  assert.ok(RELEASE_CHANNELS_SCOPE.scopeOut.length >= 6);
  assert.ok(RELEASE_CHANNELS_SCOPE.nonGoals.some((item) => /deployment/i.test(item)));
});

test("release channel taxonomy and evidence requirements are explicit", () => {
  assert.deepEqual(
    RELEASE_CHANNELS_SCOPE.channelClasses.map((channel) => channel.id),
    ["dogfood", "private-beta", "public-beta", "release-candidate", "ga", "patch"],
  );
  assert.deepEqual(
    RELEASE_CHANNELS_SCOPE.channelStates.map((state) => state.id),
    [
      "proposed",
      "evidence-collecting",
      "go-no-go-review",
      "approved",
      "published",
      "paused",
      "superseded",
      "retired",
    ],
  );
  assert.deepEqual(
    RELEASE_CHANNELS_SCOPE.requiredEvidence.map((field) => field.id),
    [
      "cutline",
      "artifact-provenance",
      "compatibility-matrix",
      "known-limitations",
      "support-route",
      "rollback-policy",
      "customer-communication",
      "decision-record",
    ],
  );
});

test("M0 dependencies map authoritative design sources and owning initiatives", () => {
  assert.deepEqual(RELEASE_CHANNELS_SCOPE.designRefs, [
    "docs/design/release-notes-upgrade-guide.md",
    "docs/design/release-artifact-provenance-retention.md",
    "docs/design/compatibility-matrix.md",
    "docs/design/beta-pilot-feedback.md",
    "docs/design/launch-messaging-claims.md",
    "docs/design/support-sla-channels.md",
    "docs/design/public-status-page-incident-communication.md",
  ]);
  assert.deepEqual(RELEASE_CHANNELS_SCOPE.adrRefs, [
    "docs/design/adr/07-portability-extensibility.md#adr-0063",
    "docs/design/adr/07-portability-extensibility.md#adr-0064",
    "docs/design/adr/07-portability-extensibility.md#adr-0095",
    "docs/design/adr/07-portability-extensibility.md#adr-0075",
  ]);
  assert.deepEqual(
    RELEASE_CHANNELS_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Release Channels",
      "V1 Release Program & Cutline",
      "Release Artifact Provenance & Retention",
      "Compatibility Matrix",
      "Release Notes & Upgrade Guide",
      "Beta Pilot & Feedback Loop",
      "Launch Support Desk & Escalation",
      "Public Status Page & Incident Communication",
    ],
  );
});

test("M1 evidence gate blocks follow-up implementation issues until M0 is accepted", () => {
  assert.deepEqual(
    RELEASE_CHANNELS_SCOPE.m1Evidence.map((evidence) => evidence.id),
    [
      "channel-taxonomy-record",
      "transition-owner-matrix",
      "evidence-checklist-fixture",
      "go-no-go-decision-template",
      "publication-support-handoff",
      "scope-boundary-register",
    ],
  );
  assert.equal(canCreateReleaseChannelsFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateReleaseChannelsFollowUp({ phase: "M4", m0Accepted: false }).allowed, false);
  assert.equal(canCreateReleaseChannelsFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateReleaseChannelsFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects deployment, artifact, compatibility, messaging, support, and follow-up creep", () => {
  assert.deepEqual(validateReleaseChannelsScope(RELEASE_CHANNELS_SCOPE), { ok: true, errors: [] });

  for (const [label, sentence] of [
    ["deployment", "Implement live deployment promotion automation for the GA channel."],
    ["artifact", "Build artifact signing storage and package publication runtime."],
    ["compatibility", "Generate browser and device compatibility matrix results for customers."],
    ["messaging", "Publish launch marketing pages and customer email campaigns."],
    ["support", "Implement support ticket routing and SLA automation for channel incidents."],
    ["follow-up", "Create M2 implementation issues before M0 scope acceptance is approved."],
  ]) {
    const result = validateReleaseChannelsScope({
      ...RELEASE_CHANNELS_SCOPE,
      scopeIn: [...RELEASE_CHANNELS_SCOPE.scopeIn, sentence],
    });

    assert.equal(result.ok, false, label);
    assert.match(result.errors.join("\n"), new RegExp(label, "i"));
  }
});

test("decision classifier routes adjacent work to owning initiatives", () => {
  assert.deepEqual(classifyReleaseChannelsDecision("define release channel taxonomy evidence"), {
    owner: "Release Channels",
    inScope: true,
  });
  assert.equal(classifyReleaseChannelsDecision("release cutline dependency map").owner, "V1 Release Program & Cutline");
  assert.equal(classifyReleaseChannelsDecision("artifact provenance retention").owner, "Release Artifact Provenance & Retention");
  assert.equal(classifyReleaseChannelsDecision("compatibility matrix browser coverage").owner, "Compatibility Matrix");
  assert.equal(classifyReleaseChannelsDecision("release notes publication").owner, "Release Notes & Upgrade Guide");
  assert.equal(classifyReleaseChannelsDecision("beta feedback intake").owner, "Beta Pilot & Feedback Loop");
  assert.equal(classifyReleaseChannelsDecision("support ticket escalation").owner, "Launch Support Desk & Escalation");
});
