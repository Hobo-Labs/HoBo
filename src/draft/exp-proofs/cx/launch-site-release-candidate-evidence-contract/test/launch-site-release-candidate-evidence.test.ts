import assert from "node:assert/strict";
import { test } from "vitest";
import { asJsonObject, type JsonBag } from "../src/json.js";


async function loadContract() {
  const module = await import("../src/launch-site-release-candidate-evidence.ts").catch((error) => ({
    __loadError: error,
  }));

  assert.equal(module.__loadError, undefined, module.__loadError?.message);
  return module;
}

test("M3 launch-site release-candidate evidence is listed and mapped to owning projects", async () => {
  const { launchSiteReleaseCandidateEvidence, validateLaunchSiteReleaseCandidateEvidence } = await loadContract();
  const result = validateLaunchSiteReleaseCandidateEvidence(launchSiteReleaseCandidateEvidence);

  assert.deepEqual(result.errors, []);
  assert.equal(launchSiteReleaseCandidateEvidence.issue, "HOBO-472");
  assert.equal(launchSiteReleaseCandidateEvidence.project, "V1 Launch Site, Messaging & Demo Assets");
  assert.equal(launchSiteReleaseCandidateEvidence.phase, "M3");
  assert.equal(launchSiteReleaseCandidateEvidence.milestone, "M3 Release candidate");
  assert.ok(launchSiteReleaseCandidateEvidence.evidence.length >= 6);

  for (const item of launchSiteReleaseCandidateEvidence.evidence) {
    assert.ok(item.ownerProject, `${item.id} missing owner project`);
    assert.ok(item.source, `${item.id} missing source`);
    assert.ok(item.acceptanceBullet, `${item.id} missing acceptance mapping`);
  }
});

test("release-candidate blockers and accepted risks have owners, dispositions, and launch-risk effects", async () => {
  const { launchSiteReleaseCandidateEvidence } = await loadContract();

  assert.ok(launchSiteReleaseCandidateEvidence.blockers.length >= 2);
  assert.ok(launchSiteReleaseCandidateEvidence.acceptedRisks.length >= 2);

  for (const blocker of launchSiteReleaseCandidateEvidence.blockers) {
    assert.ok(blocker.ownerProject, `${blocker.id} missing owner`);
    assert.ok(blocker.sourceEvidenceId, `${blocker.id} missing source evidence`);
    assert.ok(blocker.disposition, `${blocker.id} missing disposition`);
    assert.ok(["blocked", "accepted-risk", "cleared"].includes(blocker.state));
  }
  for (const risk of launchSiteReleaseCandidateEvidence.acceptedRisks) {
    assert.ok(risk.ownerProject, `${risk.id} missing owner`);
    assert.ok(risk.mitigation, `${risk.id} missing mitigation`);
    assert.ok(["unchanged", "increased", "reduced"].includes(risk.launchRiskEffect));
  }
});

test("cross-project dependencies are reflected in release cutline domains", async () => {
  const { launchSiteReleaseCandidateEvidence } = await loadContract();
  const domains = new Set(
    launchSiteReleaseCandidateEvidence.releaseCutlineDependencies.map((dependency) => dependency.readinessDomain),
  );

  assert.ok(domains.has("documentation"));
  assert.ok(domains.has("productization"));
  assert.ok(domains.has("operations-readiness"));
  assert.ok(domains.has("release-cutline"));

  for (const dependency of launchSiteReleaseCandidateEvidence.releaseCutlineDependencies) {
    assert.ok(dependency.ownerProject, `${dependency.id} missing owner`);
    assert.ok(dependency.source, `${dependency.id} missing source`);
    assert.ok(dependency.cutlineCategory.startsWith("v1-blocker."), `${dependency.id} missing cutline category`);
  }
});

test("follow-up execution issues are allowed only for missing release-candidate evidence", async () => {
  const { launchSiteReleaseCandidateEvidence, validateLaunchSiteReleaseCandidateEvidence } = await loadContract();

  assert.ok(launchSiteReleaseCandidateEvidence.followUps.length >= 1);
  assert.ok(
    launchSiteReleaseCandidateEvidence.followUps.every((item) =>
      launchSiteReleaseCandidateEvidence.evidence.some((evidence) => evidence.id === item.evidenceId && evidence.status === "missing"),
    ),
  );

  const invalid = structuredClone(launchSiteReleaseCandidateEvidence);
  invalid.followUps.push({
    id: "build-public-site-from-accepted-claim-register",
    evidenceId: "claim-register-publication-rules",
    ownerProject: "V1 Launch Site, Messaging & Demo Assets",
    reason: "should not create execution work for already accepted evidence",
  });

  const result = validateLaunchSiteReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /follow-up execution issues require missing evidence/);
});

test("parent release-readiness status update is required when launch risk changes", async () => {
  const { launchSiteReleaseCandidateEvidence, validateLaunchSiteReleaseCandidateEvidence } = await loadContract();

  assert.equal(launchSiteReleaseCandidateEvidence.initiativeStatus.parentInitiative, "HoBo v1 Release Readiness");
  assert.equal(launchSiteReleaseCandidateEvidence.initiativeStatus.launchRiskChange, "increased");
  assert.equal(launchSiteReleaseCandidateEvidence.initiativeStatus.statusUpdateRequired, true);

  const invalid = structuredClone(launchSiteReleaseCandidateEvidence);
  invalid.initiativeStatus.updateSource = "";

  const result = validateLaunchSiteReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /initiative status update source is required/);
});

test("scope guard rejects launch-site implementation, final public copy, and unsupported GA claims", async () => {
  const { launchSiteReleaseCandidateEvidence, validateLaunchSiteReleaseCandidateEvidence } = await loadContract();
  const invalid = structuredClone(launchSiteReleaseCandidateEvidence);

  invalid.scopeOut.push("Build the public launch site and publish final launch copy.");
  invalid.publicClaimGuards.push({
    id: "ga-ready-from-rc-demo",
    claim: "Release-candidate demo assets prove GA launch readiness.",
    evidenceId: "golden-path-demo-assets",
    disposition: "publish",
  });

  const result = validateLaunchSiteReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /launch-site implementation is scope-out/);
  assert.match(result.errors.join("\n"), /final public copy is scope-out/);
  assert.match(result.errors.join("\n"), /GA launch claims require GA handoff evidence/);
});

test("malformed evidence collections return parser errors instead of throwing", async () => {
  const { launchSiteReleaseCandidateEvidence, validateLaunchSiteReleaseCandidateEvidence } = await loadContract();
  const invalid: JsonBag = { ...asJsonObject(structuredClone(launchSiteReleaseCandidateEvidence)) };

  invalid.evidence = {};
  invalid.blockers = "not-blockers";
  invalid.acceptedRisks = null;
  invalid.releaseCutlineDependencies = false;
  invalid.followUps = {};
  invalid.scopeOut = {};
  invalid.publicClaimGuards = {};

  const result = validateLaunchSiteReleaseCandidateEvidence(invalid);

  assert.match(result.errors.join("\n"), /M3 launch-site evidence must contain at least six owner-mapped entries/);
  assert.match(result.errors.join("\n"), /blockers must record at least two release-candidate blockers/);
  assert.match(result.errors.join("\n"), /accepted risks must record at least two launch risk entries/);
  assert.match(result.errors.join("\n"), /release cutline dependencies must map at least four readiness domains/);
});
