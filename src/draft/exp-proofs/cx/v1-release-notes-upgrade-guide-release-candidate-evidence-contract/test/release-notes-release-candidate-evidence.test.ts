import assert from "node:assert/strict";
import { test } from "vitest";
import { asJsonObject, type JsonBag } from "../src/json.js";


async function loadContract() {
  const module = await import("../src/release-notes-release-candidate-evidence.ts").catch((error) => ({
    __loadError: error,
  }));

  assert.equal(module.__loadError, undefined, module.__loadError?.message);
  return module;
}

test("M3 release-candidate release-notes evidence is listed and mapped to owners", async () => {
  const {
    releaseNotesReleaseCandidateEvidence,
    validateReleaseNotesReleaseCandidateEvidence,
  } = await loadContract();

  const result = validateReleaseNotesReleaseCandidateEvidence(releaseNotesReleaseCandidateEvidence);

  assert.deepEqual(result.errors, []);
  assert.equal(releaseNotesReleaseCandidateEvidence.issue, "HOBO-473");
  assert.equal(releaseNotesReleaseCandidateEvidence.phase, "M3");
  assert.equal(releaseNotesReleaseCandidateEvidence.milestone, "M3 Release candidate");
  assert.ok(releaseNotesReleaseCandidateEvidence.evidence.length >= 7);

  for (const item of releaseNotesReleaseCandidateEvidence.evidence) {
    assert.ok(item.ownerProject, `${item.id} missing owner project`);
    assert.ok(item.source, `${item.id} missing source`);
    assert.ok(item.acceptanceBullet, `${item.id} missing acceptance mapping`);
  }
});

test("release-candidate blockers and accepted risks are recorded and tied to evidence", async () => {
  const {
    releaseNotesReleaseCandidateEvidence,
    validateReleaseNotesReleaseCandidateEvidence,
  } = await loadContract();

  assert.ok(releaseNotesReleaseCandidateEvidence.blockers.length >= 1);
  assert.ok(releaseNotesReleaseCandidateEvidence.acceptedRisks.length >= 2);

  const evidenceIds = new Set(releaseNotesReleaseCandidateEvidence.evidence.map((item) => item.id));
  for (const blocker of releaseNotesReleaseCandidateEvidence.blockers) {
    assert.ok(blocker.ownerProject, `${blocker.id} missing owner`);
    assert.ok(blocker.disposition, `${blocker.id} missing disposition`);
    assert.ok(["blocked", "accepted-risk", "cleared"].includes(blocker.state));
    assert.ok(evidenceIds.has(blocker.sourceEvidenceId), `${blocker.id} cites unknown evidence`);
  }

  const invalid = structuredClone(releaseNotesReleaseCandidateEvidence);
  invalid.blockers = [];
  invalid.acceptedRisks = [];

  const result = validateReleaseNotesReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /blockers must record at least one release-candidate blocker/);
  assert.match(result.errors.join("\n"), /accepted risks must record at least two launch risk entries/);
});

test("cross-project release-note dependencies are reflected in release cutline domains", async () => {
  const {
    releaseNotesReleaseCandidateEvidence,
    validateReleaseNotesReleaseCandidateEvidence,
  } = await loadContract();

  const domains = new Set(
    releaseNotesReleaseCandidateEvidence.releaseCutlineDependencies.map((dependency) => dependency.readinessDomain),
  );

  assert.ok(domains.has("documentation"));
  assert.ok(domains.has("release-cutline"));
  assert.ok(domains.has("operations-readiness"));
  assert.ok(domains.has("support"));
  assert.ok(domains.has("compatibility"));

  const invalid = structuredClone(releaseNotesReleaseCandidateEvidence);
  invalid.releaseCutlineDependencies = [
    {
      id: "missing-cutline-prefix",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      readinessDomain: "documentation",
      cutlineCategory: "documentation",
      source: "docs/design/release-notes-upgrade-guide.md",
    },
  ];

  const result = validateReleaseNotesReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /release cutline dependencies must map at least five readiness domains/);
  assert.match(result.errors.join("\n"), /dependency must cite a v1-blocker cutline category/);
});

test("follow-up execution issues are allowed only for missing evidence and parent status is synced", async () => {
  const {
    releaseNotesReleaseCandidateEvidence,
    validateReleaseNotesReleaseCandidateEvidence,
  } = await loadContract();

  assert.equal(releaseNotesReleaseCandidateEvidence.initiativeStatus.parentInitiative, "HoBo v1 Release Readiness");
  assert.equal(releaseNotesReleaseCandidateEvidence.initiativeStatus.statusUpdateRequired, true);
  assert.ok(
    releaseNotesReleaseCandidateEvidence.followUps.every((item) =>
      releaseNotesReleaseCandidateEvidence.evidence.some(
        (evidence) => evidence.id === item.evidenceId && evidence.status === "missing",
      ),
    ),
  );

  const invalid = structuredClone(releaseNotesReleaseCandidateEvidence);
  invalid.followUps.push({
    id: "HOBO-9999",
    evidenceId: "release-candidate-notes-draft",
    ownerProject: "V1 Release Notes & Upgrade Guide",
    reason: "create execution work for already accepted evidence",
  });
  invalid.initiativeStatus.updateSource = "";

  const result = validateReleaseNotesReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /follow-up execution issues require missing evidence/);
  assert.match(result.errors.join("\n"), /initiative status update source is required/);
});

test("scope guards reject final notes, unsupported upgrade or compatibility claims, support promises, and GA promotion", async () => {
  const {
    releaseNotesReleaseCandidateEvidence,
    validateReleaseNotesReleaseCandidateEvidence,
  } = await loadContract();

  const invalid = structuredClone(releaseNotesReleaseCandidateEvidence);
  invalid.scopeOut.push("Publish the final release notes to customers.");
  invalid.scopeOut.push("Guarantee all browsers and platforms are compatible.");
  invalid.scopeOut.push("Promise zero-downtime upgrades for every install path.");
  invalid.scopeOut.push("Approve production support contact response-time promises.");
  invalid.publicClaimGuards.push({
    id: "ga-release-notes-ready",
    claim: "M3 release-candidate release notes prove GA upgrade readiness.",
    evidenceId: "release-candidate-notes-draft",
    disposition: "publish",
  });

  const result = validateReleaseNotesReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /final release-note publication is scope-out/);
  assert.match(result.errors.join("\n"), /unsupported compatibility guarantee is scope-out/);
  assert.match(result.errors.join("\n"), /unsupported upgrade guarantee is scope-out/);
  assert.match(result.errors.join("\n"), /support contact promise is scope-out/);
  assert.match(result.errors.join("\n"), /GA release-note claims require GA handoff evidence/);
});

test("malformed evidence collections return parser errors instead of throwing", async () => {
  const {
    releaseNotesReleaseCandidateEvidence,
    validateReleaseNotesReleaseCandidateEvidence,
  } = await loadContract();
  const invalid: JsonBag = { ...asJsonObject(structuredClone(releaseNotesReleaseCandidateEvidence)) };

  invalid.evidence = {};
  invalid.blockers = "not-blockers";
  invalid.acceptedRisks = null;
  invalid.releaseCutlineDependencies = false;
  invalid.followUps = {};
  invalid.scopeOut = {};
  invalid.publicClaimGuards = {};

  const result = validateReleaseNotesReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /M3 release-note evidence must contain at least seven owner-mapped entries/);
  assert.match(result.errors.join("\n"), /blockers must record at least one release-candidate blocker/);
  assert.match(result.errors.join("\n"), /accepted risks must record at least two launch risk entries/);
  assert.match(result.errors.join("\n"), /release cutline dependencies must map at least five readiness domains/);
});
