import assert from "node:assert/strict";
import { test } from "vitest";
import { asJsonObject, type JsonBag } from "../src/json.js";


async function loadContract() {
  const module = await import("../src/launch-site-demo-alpha-evidence.ts").catch((error) => ({
    __loadError: error,
  }));

  assert.equal(module.__loadError, undefined, module.__loadError?.message);
  return module;
}

test("M1 dogfood alpha evidence is listed and mapped to owning projects", async () => {
  const { launchSiteDemoAlphaEvidence, validateLaunchSiteDemoAlphaEvidence } = await loadContract();
  const result = validateLaunchSiteDemoAlphaEvidence(launchSiteDemoAlphaEvidence);

  assert.deepEqual(result.errors, []);
  assert.equal(launchSiteDemoAlphaEvidence.issue, "HOBO-458");
  assert.equal(launchSiteDemoAlphaEvidence.phase, "M1");
  assert.equal(launchSiteDemoAlphaEvidence.milestone, "M1 Dogfood/alpha proof");
  assert.ok(launchSiteDemoAlphaEvidence.evidence.length >= 5);

  for (const item of launchSiteDemoAlphaEvidence.evidence) {
    assert.ok(item.ownerProject, `${item.id} missing owner project`);
    assert.ok(item.source, `${item.id} missing source`);
    assert.ok(item.acceptanceBullet, `${item.id} missing acceptance mapping`);
  }
});

test("blockers and accepted risks are recorded with owner and mitigation", async () => {
  const { launchSiteDemoAlphaEvidence } = await loadContract();

  assert.ok(launchSiteDemoAlphaEvidence.blockers.length >= 1);
  assert.ok(launchSiteDemoAlphaEvidence.acceptedRisks.length >= 2);

  for (const risk of launchSiteDemoAlphaEvidence.acceptedRisks) {
    assert.ok(risk.ownerProject, `${risk.id} missing owner`);
    assert.ok(risk.mitigation, `${risk.id} missing mitigation`);
    assert.ok(["unchanged", "increased", "reduced"].includes(risk.launchRiskEffect));
  }
});

test("cross-project dependencies are reflected in release cutline domains", async () => {
  const { launchSiteDemoAlphaEvidence } = await loadContract();
  const domains = new Set(launchSiteDemoAlphaEvidence.releaseCutlineDependencies.map((dependency) => dependency.readinessDomain));

  assert.ok(domains.has("documentation"));
  assert.ok(domains.has("productization"));
  assert.ok(domains.has("operations-readiness"));

  for (const dependency of launchSiteDemoAlphaEvidence.releaseCutlineDependencies) {
    assert.ok(dependency.ownerProject, `${dependency.id} missing owner`);
    assert.ok(dependency.cutlineCategory.startsWith("v1-blocker."), `${dependency.id} missing cutline category`);
    assert.ok(dependency.source, `${dependency.id} missing source`);
  }
});

test("follow-up execution issues are allowed only for missing evidence", async () => {
  const { launchSiteDemoAlphaEvidence, validateLaunchSiteDemoAlphaEvidence } = await loadContract();

  assert.deepEqual(launchSiteDemoAlphaEvidence.followUps, []);

  const invalid = structuredClone(launchSiteDemoAlphaEvidence);
  invalid.followUps.push({
    id: "ship-accepted-claim-anyway",
    evidenceId: "claim-register",
    ownerProject: "V1 Launch Site, Messaging & Demo Assets",
    reason: "should not create execution work for accepted evidence",
  });

  const result = validateLaunchSiteDemoAlphaEvidence(invalid);

  assert.match(result.errors.join("\n"), /follow-up execution issues require missing evidence/);
});

test("malformed evidence collections return parser errors instead of throwing", async () => {
  const { launchSiteDemoAlphaEvidence, validateLaunchSiteDemoAlphaEvidence } = await loadContract();
  const invalid: JsonBag = { ...asJsonObject(structuredClone(launchSiteDemoAlphaEvidence)) };

  invalid.evidence = {};
  invalid.blockers = "not-blockers";
  invalid.acceptedRisks = null;
  invalid.releaseCutlineDependencies = false;
  invalid.followUps = {};
  invalid.scopeOut = {};
  invalid.publicClaimGuards = {};

  const result = validateLaunchSiteDemoAlphaEvidence(invalid);

  assert.match(result.errors.join("\n"), /M1 evidence must contain at least five owner-mapped entries/);
  assert.match(result.errors.join("\n"), /blockers must record at least one alpha gate blocker/);
  assert.match(result.errors.join("\n"), /accepted risks must record at least two launch risk entries/);
  assert.match(result.errors.join("\n"), /release cutline dependencies must map at least three readiness domains/);
});

test("parent initiative status update is required when launch risk changes", async () => {
  const { launchSiteDemoAlphaEvidence, validateLaunchSiteDemoAlphaEvidence } = await loadContract();

  assert.equal(launchSiteDemoAlphaEvidence.initiativeStatus.launchRiskChange, "unchanged");
  assert.equal(launchSiteDemoAlphaEvidence.initiativeStatus.statusUpdateRequired, false);

  const invalid = structuredClone(launchSiteDemoAlphaEvidence);
  invalid.initiativeStatus.launchRiskChange = "increased";
  invalid.initiativeStatus.statusUpdateRequired = true;
  invalid.initiativeStatus.updateSource = "";

  const result = validateLaunchSiteDemoAlphaEvidence(invalid);

  assert.match(result.errors.join("\n"), /initiative status update source is required/);
});

test("scope guard rejects launch-site implementation and unsupported public claims", async () => {
  const { launchSiteDemoAlphaEvidence, validateLaunchSiteDemoAlphaEvidence } = await loadContract();
  const invalid = structuredClone(launchSiteDemoAlphaEvidence);

  invalid.scopeOut.push("Build and publish the public launch site.");
  invalid.publicClaimGuards.push({
    id: "production-ready-without-live-evidence",
    claim: "HoBo launch demo is production-ready.",
    evidenceId: "demo-golden-path",
    disposition: "publish",
  });

  const result = validateLaunchSiteDemoAlphaEvidence(invalid);

  assert.match(result.errors.join("\n"), /launch site implementation is scope-out/);
  assert.match(result.errors.join("\n"), /public claims require accepted live evidence/);
});
