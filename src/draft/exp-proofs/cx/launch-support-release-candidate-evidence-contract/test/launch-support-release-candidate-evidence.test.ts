import assert from "node:assert/strict";
import { test } from "vitest";
import { asJsonObject, type JsonBag } from "../src/json.js";


async function loadContract() {
  const module = await import("../src/launch-support-release-candidate-evidence.ts").catch((error) => ({
    __loadError: error,
  }));

  assert.equal(module.__loadError, undefined, module.__loadError?.message);
  return module;
}

test("M3 release-candidate support evidence is listed and mapped to owning projects", async () => {
  const {
    launchSupportReleaseCandidateEvidence,
    validateLaunchSupportReleaseCandidateEvidence,
  } = await loadContract();

  const result = validateLaunchSupportReleaseCandidateEvidence(launchSupportReleaseCandidateEvidence);

  assert.deepEqual(result.errors, []);
  assert.equal(launchSupportReleaseCandidateEvidence.issue, "HOBO-474");
  assert.equal(launchSupportReleaseCandidateEvidence.phase, "M3");
  assert.equal(launchSupportReleaseCandidateEvidence.milestone, "M3 Release candidate");
  assert.ok(launchSupportReleaseCandidateEvidence.evidence.length >= 6);

  for (const item of launchSupportReleaseCandidateEvidence.evidence) {
    assert.ok(item.ownerProject, `${item.id} missing owner project`);
    assert.ok(item.source, `${item.id} missing source`);
    assert.ok(item.acceptanceBullet, `${item.id} missing acceptance mapping`);
  }
});

test("release-candidate support blockers and accepted risks are recorded and tied to evidence", async () => {
  const {
    launchSupportReleaseCandidateEvidence,
    validateLaunchSupportReleaseCandidateEvidence,
  } = await loadContract();

  assert.ok(launchSupportReleaseCandidateEvidence.blockers.length >= 1);
  assert.ok(launchSupportReleaseCandidateEvidence.acceptedRisks.length >= 2);

  const evidenceIds = new Set(launchSupportReleaseCandidateEvidence.evidence.map((item) => item.id));
  for (const blocker of launchSupportReleaseCandidateEvidence.blockers) {
    assert.ok(blocker.ownerProject, `${blocker.id} missing owner`);
    assert.ok(blocker.disposition, `${blocker.id} missing disposition`);
    assert.ok(["blocked", "accepted-risk", "cleared"].includes(blocker.state));
    assert.ok(evidenceIds.has(blocker.sourceEvidenceId), `${blocker.id} cites unknown evidence`);
  }

  const invalid = structuredClone(launchSupportReleaseCandidateEvidence);
  invalid.blockers = [];
  invalid.acceptedRisks = [];

  const result = validateLaunchSupportReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /blockers must record at least one release-candidate blocker/);
  assert.match(result.errors.join("\n"), /accepted risks must record at least two launch risk entries/);
});

test("cross-project dependencies are reflected in release cutline domains", async () => {
  const {
    launchSupportReleaseCandidateEvidence,
    validateLaunchSupportReleaseCandidateEvidence,
  } = await loadContract();

  const domains = new Set(
    launchSupportReleaseCandidateEvidence.releaseCutlineDependencies.map((dependency) => dependency.readinessDomain),
  );

  assert.ok(domains.has("support"));
  assert.ok(domains.has("operations-readiness"));
  assert.ok(domains.has("documentation"));
  assert.ok(domains.has("security"));
  assert.ok(domains.has("release-cutline"));

  const invalid = structuredClone(launchSupportReleaseCandidateEvidence);
  invalid.releaseCutlineDependencies = [
    {
      id: "missing-cutline-prefix",
      ownerProject: "V1 Launch Support Desk & Escalation",
      readinessDomain: "support",
      cutlineCategory: "support",
      source: "docs/design/launch-support-escalation.md",
    },
  ];

  const result = validateLaunchSupportReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /release cutline dependencies must map at least five readiness domains/);
  assert.match(result.errors.join("\n"), /dependency must cite a v1-blocker cutline category/);
});

test("follow-up execution issues are allowed only for missing evidence and parent status is synced", async () => {
  const {
    launchSupportReleaseCandidateEvidence,
    validateLaunchSupportReleaseCandidateEvidence,
  } = await loadContract();

  assert.equal(launchSupportReleaseCandidateEvidence.initiativeStatus.parentInitiative, "HoBo v1 Release Readiness");
  assert.equal(launchSupportReleaseCandidateEvidence.initiativeStatus.statusUpdateRequired, true);
  assert.ok(
    launchSupportReleaseCandidateEvidence.followUps.every((item) =>
      launchSupportReleaseCandidateEvidence.evidence.some(
        (evidence) => evidence.id === item.evidenceId && evidence.status === "missing",
      ),
    ),
  );

  const invalid = structuredClone(launchSupportReleaseCandidateEvidence);
  invalid.followUps.push({
    id: "support-drill-tooling",
    evidenceId: "release-candidate-support-drill",
    ownerProject: "V1 Launch Support Desk & Escalation",
    reason: "create execution work for already accepted evidence",
  });
  invalid.initiativeStatus.updateSource = "";

  const result = validateLaunchSupportReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /follow-up execution issues require missing evidence/);
  assert.match(result.errors.join("\n"), /initiative status update source is required/);
});

test("scope guards reject support tooling, customer data, status-page publishing, SLA, and GA claim creep", async () => {
  const {
    launchSupportReleaseCandidateEvidence,
    validateLaunchSupportReleaseCandidateEvidence,
  } = await loadContract();

  const invalid = structuredClone(launchSupportReleaseCandidateEvidence);
  invalid.scopeOut.push("Implement the support ticket queue for release candidate customers.");
  invalid.scopeOut.push("Publish the public status page update automatically.");
  invalid.scopeOut.push("Read live customer data to debug support incidents.");
  invalid.scopeOut.push("Approve a customer-facing SLA response-time guarantee.");
  invalid.publicClaimGuards.push({
    id: "ga-support-ready",
    claim: "M3 support release-candidate evidence proves GA support readiness.",
    evidenceId: "release-candidate-support-drill",
    disposition: "publish",
  });

  const result = validateLaunchSupportReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /support ticket queue implementation is scope-out/);
  assert.match(result.errors.join("\n"), /status-page publication is scope-out/);
  assert.match(result.errors.join("\n"), /customer-data access is scope-out/);
  assert.match(result.errors.join("\n"), /customer-facing SLA approval is scope-out/);
  assert.match(result.errors.join("\n"), /GA support claims require GA handoff evidence/);
});

test("malformed evidence collections return parser errors instead of throwing", async () => {
  const {
    launchSupportReleaseCandidateEvidence,
    validateLaunchSupportReleaseCandidateEvidence,
  } = await loadContract();
  const invalid: JsonBag = { ...asJsonObject(structuredClone(launchSupportReleaseCandidateEvidence)) };

  invalid.evidence = {};
  invalid.blockers = "not-blockers";
  invalid.acceptedRisks = null;
  invalid.releaseCutlineDependencies = false;
  invalid.followUps = {};
  invalid.scopeOut = {};
  invalid.publicClaimGuards = {};

  const result = validateLaunchSupportReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /M3 support evidence must contain at least six owner-mapped entries/);
  assert.match(result.errors.join("\n"), /blockers must record at least one release-candidate blocker/);
  assert.match(result.errors.join("\n"), /accepted risks must record at least two launch risk entries/);
  assert.match(result.errors.join("\n"), /release cutline dependencies must map at least five readiness domains/);
});
