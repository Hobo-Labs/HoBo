import assert from "node:assert/strict";
import { test } from "vitest";
import { asJsonObject, type JsonBag } from "../src/json.js";


async function loadContract() {
  const module = await import("../src/release-notes-ga-handoff-evidence.ts").catch((error) => ({
    __loadError: error,
  }));

  assert.equal(module.__loadError, undefined, module.__loadError?.message);
  return module;
}

test("M4 GA release-note handoff evidence is listed and mapped to owners", async () => {
  const { releaseNotesGaHandoffEvidence, validateReleaseNotesGaHandoffEvidence } = await loadContract();

  const result = validateReleaseNotesGaHandoffEvidence(releaseNotesGaHandoffEvidence);

  assert.deepEqual(result.errors, []);
  assert.equal(releaseNotesGaHandoffEvidence.issue, "HOBO-480");
  assert.equal(releaseNotesGaHandoffEvidence.phase, "M4");
  assert.equal(releaseNotesGaHandoffEvidence.milestone, "M4 GA handoff");
  assert.ok(releaseNotesGaHandoffEvidence.evidence.length >= 8);

  for (const item of releaseNotesGaHandoffEvidence.evidence) {
    assert.ok(item.ownerProject, `${item.id} missing owner project`);
    assert.ok(item.source, `${item.id} missing source`);
    assert.ok(item.acceptanceBullet, `${item.id} missing acceptance mapping`);
  }
});

test("GA blockers and accepted risks are recorded and tied to evidence", async () => {
  const { releaseNotesGaHandoffEvidence, validateReleaseNotesGaHandoffEvidence } = await loadContract();

  assert.ok(releaseNotesGaHandoffEvidence.blockers.length >= 2);
  assert.ok(releaseNotesGaHandoffEvidence.acceptedRisks.length >= 2);

  const evidenceIds = new Set(releaseNotesGaHandoffEvidence.evidence.map((item) => item.id));
  for (const blocker of releaseNotesGaHandoffEvidence.blockers) {
    assert.ok(blocker.ownerProject, `${blocker.id} missing owner`);
    assert.ok(blocker.disposition, `${blocker.id} missing disposition`);
    assert.ok(["cleared", "accepted-risk"].includes(blocker.state));
    assert.ok(evidenceIds.has(blocker.sourceEvidenceId), `${blocker.id} cites unknown evidence`);
  }

  const invalid = structuredClone(releaseNotesGaHandoffEvidence);
  invalid.blockers = [];
  invalid.acceptedRisks = [];

  const result = validateReleaseNotesGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /blockers must record at least two GA release-note entries/);
  assert.match(result.errors.join("\n"), /accepted risks must record at least two GA release-note entries/);
});

test("cross-project release-note dependencies are reflected in release cutline domains", async () => {
  const { releaseNotesGaHandoffEvidence, validateReleaseNotesGaHandoffEvidence } = await loadContract();

  const domains = new Set(
    releaseNotesGaHandoffEvidence.releaseCutlineDependencies.map((dependency) => dependency.readinessDomain),
  );

  assert.ok(domains.has("documentation"));
  assert.ok(domains.has("release-cutline"));
  assert.ok(domains.has("operations-readiness"));
  assert.ok(domains.has("support"));
  assert.ok(domains.has("compatibility"));
  assert.ok(domains.has("migration"));

  const invalid = structuredClone(releaseNotesGaHandoffEvidence);
  invalid.releaseCutlineDependencies = [
    {
      id: "missing-cutline-prefix",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      readinessDomain: "documentation",
      cutlineCategory: "documentation",
      source: "docs/design/release-notes-upgrade-guide.md",
    },
  ];

  const result = validateReleaseNotesGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /release cutline dependencies must map at least six readiness domains/);
  assert.match(result.errors.join("\n"), /dependency must cite a v1-blocker cutline category/);
});

test("follow-up creation is limited to missing evidence and parent readiness status is synced", async () => {
  const { releaseNotesGaHandoffEvidence, validateReleaseNotesGaHandoffEvidence } = await loadContract();

  assert.equal(releaseNotesGaHandoffEvidence.initiativeStatus.parentInitiative, "HoBo v1 Release Readiness");
  assert.equal(releaseNotesGaHandoffEvidence.initiativeStatus.statusUpdateRequired, true);
  assert.equal(releaseNotesGaHandoffEvidence.missingEvidence.length, 0);
  assert.equal(releaseNotesGaHandoffEvidence.followUps.length, 0);

  const invalid = structuredClone(releaseNotesGaHandoffEvidence);
  invalid.followUps.push({
    id: "HOBO-999",
    evidenceId: "final-release-notes-signoff",
    ownerProject: "V1 Release Notes & Upgrade Guide",
    reason: "create execution work for evidence that is already accepted",
  });
  invalid.initiativeStatus.updateSource = "";

  const result = validateReleaseNotesGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /follow-up execution issues require missing evidence/);
  assert.match(result.errors.join("\n"), /initiative status update source is required/);
});

test("scope guards reject publication, docs portal, customer comms, unsupported guarantees, and support promises", async () => {
  const { releaseNotesGaHandoffEvidence, validateReleaseNotesGaHandoffEvidence } = await loadContract();

  const invalid = structuredClone(releaseNotesGaHandoffEvidence);
  invalid.scopeOut.push("Publish final release notes to customers from this proof package.");
  invalid.scopeOut.push("Implement docs portal publication and customer email distribution.");
  invalid.scopeOut.push("Guarantee all browsers, platforms, and upgrade paths are compatible.");
  invalid.scopeOut.push("Promise zero-downtime upgrades for every install path.");
  invalid.scopeOut.push("Approve support SLA response-time promises.");
  invalid.publicClaimGuards.push({
    id: "unsupported-release-claim",
    claim: "HoBo V1 is GA-ready with all platforms compatible and zero-downtime upgrades.",
    evidenceId: "final-release-notes-signoff",
    disposition: "publish",
  });

  const result = validateReleaseNotesGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /final release-note publication is scope-out/);
  assert.match(result.errors.join("\n"), /docs portal or customer communication implementation is scope-out/);
  assert.match(result.errors.join("\n"), /unsupported compatibility guarantee is scope-out/);
  assert.match(result.errors.join("\n"), /unsupported upgrade guarantee is scope-out/);
  assert.match(result.errors.join("\n"), /support promise is scope-out/);
  assert.match(result.errors.join("\n"), /unsupported public release-note claim/);
});

test("malformed evidence collections return parser errors instead of throwing", async () => {
  const { releaseNotesGaHandoffEvidence, validateReleaseNotesGaHandoffEvidence } = await loadContract();
  const invalid: JsonBag = { ...asJsonObject(structuredClone(releaseNotesGaHandoffEvidence)) };

  invalid.evidence = {};
  invalid.blockers = "not-blockers";
  invalid.acceptedRisks = null;
  invalid.releaseCutlineDependencies = false;
  invalid.missingEvidence = {};
  invalid.followUps = {};
  invalid.scopeOut = {};
  invalid.publicClaimGuards = {};

  const result = validateReleaseNotesGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /evidence must be an array/);
  assert.match(result.errors.join("\n"), /blockers must be an array/);
  assert.match(result.errors.join("\n"), /release cutline dependencies must be an array/);
  assert.match(result.errors.join("\n"), /scope-out guards must be an array/);
});
