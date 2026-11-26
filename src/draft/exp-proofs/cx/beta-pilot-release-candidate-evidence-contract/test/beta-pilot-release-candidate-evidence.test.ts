import assert from "node:assert/strict";
import { test } from "vitest";
import { asJsonObject, type JsonBag } from "../src/json.js";


async function loadContract() {
  const module = await import("../src/beta-pilot-release-candidate-evidence.ts").catch((error) => ({
    __loadError: error,
  }));

  assert.equal(module.__loadError, undefined, module.__loadError?.message);
  return module;
}

test("M3 release-candidate evidence is listed and mapped to owning projects", async () => {
  const { betaPilotReleaseCandidateEvidence, validateBetaPilotReleaseCandidateEvidence } = await loadContract();
  const result = validateBetaPilotReleaseCandidateEvidence(betaPilotReleaseCandidateEvidence);

  assert.deepEqual(result.errors, []);
  assert.equal(betaPilotReleaseCandidateEvidence.issue, "HOBO-470");
  assert.equal(betaPilotReleaseCandidateEvidence.phase, "M3");
  assert.equal(betaPilotReleaseCandidateEvidence.milestone, "M3 Release candidate");
  assert.ok(betaPilotReleaseCandidateEvidence.evidence.length >= 5);

  for (const item of betaPilotReleaseCandidateEvidence.evidence) {
    assert.ok(item.ownerProject, `${item.id} missing owner project`);
    assert.ok(item.source, `${item.id} missing source`);
    assert.ok(item.acceptanceBullet, `${item.id} missing acceptance mapping`);
  }
});

test("release-candidate blockers and accepted risks are recorded with owners and dispositions", async () => {
  const { betaPilotReleaseCandidateEvidence } = await loadContract();

  assert.ok(betaPilotReleaseCandidateEvidence.blockers.length >= 1);
  assert.ok(betaPilotReleaseCandidateEvidence.acceptedRisks.length >= 2);

  for (const blocker of betaPilotReleaseCandidateEvidence.blockers) {
    assert.ok(blocker.ownerProject, `${blocker.id} missing owner`);
    assert.ok(blocker.disposition, `${blocker.id} missing disposition`);
    assert.ok(["blocked", "accepted-risk", "cleared"].includes(blocker.state));
  }
  for (const risk of betaPilotReleaseCandidateEvidence.acceptedRisks) {
    assert.ok(risk.ownerProject, `${risk.id} missing owner`);
    assert.ok(risk.mitigation, `${risk.id} missing mitigation`);
    assert.ok(["unchanged", "increased", "reduced"].includes(risk.launchRiskEffect));
  }
});

test("cross-project dependencies are reflected in release cutline domains", async () => {
  const { betaPilotReleaseCandidateEvidence } = await loadContract();
  const domains = new Set(betaPilotReleaseCandidateEvidence.releaseCutlineDependencies.map((dependency) => dependency.readinessDomain));

  assert.ok(domains.has("documentation"));
  assert.ok(domains.has("productization"));
  assert.ok(domains.has("support"));
  assert.ok(domains.has("operations-readiness"));

  for (const dependency of betaPilotReleaseCandidateEvidence.releaseCutlineDependencies) {
    assert.ok(dependency.ownerProject, `${dependency.id} missing owner`);
    assert.ok(dependency.cutlineCategory.startsWith("v1-blocker."), `${dependency.id} missing cutline category`);
    assert.ok(dependency.source, `${dependency.id} missing source`);
  }
});

test("follow-up execution issues are allowed only for missing release-candidate evidence", async () => {
  const { betaPilotReleaseCandidateEvidence, validateBetaPilotReleaseCandidateEvidence } = await loadContract();

  assert.ok(betaPilotReleaseCandidateEvidence.followUps.length >= 1);
  assert.ok(
    betaPilotReleaseCandidateEvidence.followUps.every((item) =>
      betaPilotReleaseCandidateEvidence.evidence.some((evidence) => evidence.id === item.evidenceId && evidence.status === "missing"),
    ),
  );

  const invalid = structuredClone(betaPilotReleaseCandidateEvidence);
  invalid.followUps.push({
    id: "ship-accepted-note-anyway",
    evidenceId: "feedback-intake-triage",
    ownerProject: "V1 Beta Pilot & Feedback Loop",
    reason: "should not create execution work for already accepted evidence",
  });

  const result = validateBetaPilotReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /follow-up execution issues require missing evidence/);
});

test("parent readiness status update is required when release-candidate risk changes", async () => {
  const { betaPilotReleaseCandidateEvidence, validateBetaPilotReleaseCandidateEvidence } = await loadContract();

  assert.equal(betaPilotReleaseCandidateEvidence.initiativeStatus.launchRiskChange, "increased");
  assert.equal(betaPilotReleaseCandidateEvidence.initiativeStatus.statusUpdateRequired, true);

  const invalid = structuredClone(betaPilotReleaseCandidateEvidence);
  invalid.initiativeStatus.updateSource = "";

  const result = validateBetaPilotReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /initiative status update source is required/);
});

test("scope guard rejects customer onboarding and beta-to-GA claim promotion", async () => {
  const { betaPilotReleaseCandidateEvidence, validateBetaPilotReleaseCandidateEvidence } = await loadContract();
  const invalid = structuredClone(betaPilotReleaseCandidateEvidence);

  invalid.scopeOut.push("Onboard the next private beta customer cohort.");
  invalid.publicClaimGuards.push({
    id: "ga-ready-from-beta",
    claim: "Beta pilot feedback proves GA readiness.",
    evidenceId: "beta-exit-criteria",
    disposition: "publish",
  });

  const result = validateBetaPilotReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /customer onboarding is scope-out/);
  assert.match(result.errors.join("\n"), /GA claims require GA handoff evidence/);
});

test("malformed evidence collections return parser errors instead of throwing", async () => {
  const { betaPilotReleaseCandidateEvidence, validateBetaPilotReleaseCandidateEvidence } = await loadContract();
  const invalid: JsonBag = { ...asJsonObject(structuredClone(betaPilotReleaseCandidateEvidence)) };

  invalid.evidence = {};
  invalid.blockers = "not-blockers";
  invalid.acceptedRisks = null;
  invalid.releaseCutlineDependencies = false;
  invalid.followUps = {};
  invalid.scopeOut = {};
  invalid.publicClaimGuards = {};

  const result = validateBetaPilotReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /M3 evidence must contain at least five owner-mapped entries/);
  assert.match(result.errors.join("\n"), /blockers must record at least one release-candidate blocker/);
  assert.match(result.errors.join("\n"), /accepted risks must record at least two launch risk entries/);
  assert.match(result.errors.join("\n"), /release cutline dependencies must map at least four readiness domains/);
});
