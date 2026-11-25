import assert from "node:assert/strict";
import { test } from "vitest";
import { asJsonObject, type JsonBag } from "../src/json.js";


async function loadContract() {
  const module = await import("../src/launch-site-ga-handoff-evidence.ts").catch((error) => ({
    __loadError: error,
  }));

  assert.equal(module.__loadError, undefined, module.__loadError?.message);
  return module;
}

test("M4 GA handoff evidence is listed and mapped to owning projects", async () => {
  const { launchSiteGaHandoffEvidence, validateLaunchSiteGaHandoffEvidence } = await loadContract();
  const result = validateLaunchSiteGaHandoffEvidence(launchSiteGaHandoffEvidence);

  assert.deepEqual(result.errors, []);
  assert.equal(launchSiteGaHandoffEvidence.issue, "HOBO-479");
  assert.equal(launchSiteGaHandoffEvidence.phase, "M4");
  assert.equal(launchSiteGaHandoffEvidence.milestone, "M4 GA handoff");
  assert.ok(launchSiteGaHandoffEvidence.evidence.length >= 6);

  for (const item of launchSiteGaHandoffEvidence.evidence) {
    assert.ok(item.ownerProject, `${item.id} missing owner project`);
    assert.ok(item.source, `${item.id} missing source`);
    assert.ok(item.acceptanceBullet, `${item.id} missing acceptance mapping`);
  }
});

test("GA handoff blockers and accepted risks are recorded and tied to evidence", async () => {
  const { launchSiteGaHandoffEvidence, validateLaunchSiteGaHandoffEvidence } = await loadContract();

  assert.ok(launchSiteGaHandoffEvidence.blockers.length >= 2);
  assert.ok(launchSiteGaHandoffEvidence.acceptedRisks.length >= 2);

  const evidenceIds = new Set(launchSiteGaHandoffEvidence.evidence.map((item) => item.id));
  for (const blocker of launchSiteGaHandoffEvidence.blockers) {
    assert.ok(blocker.ownerProject, `${blocker.id} missing owner`);
    assert.ok(blocker.disposition, `${blocker.id} missing disposition`);
    assert.ok(["blocked", "accepted-risk", "cleared"].includes(blocker.state));
    assert.ok(evidenceIds.has(blocker.sourceEvidenceId), `${blocker.id} cites unknown evidence`);
  }

  const invalid = structuredClone(launchSiteGaHandoffEvidence);
  invalid.blockers = [];
  invalid.acceptedRisks = [];

  const result = validateLaunchSiteGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /blockers must record at least two GA handoff blockers/);
  assert.match(result.errors.join("\n"), /accepted risks must record at least two launch risk entries/);
});

test("cross-project dependencies are reflected in release cutline domains", async () => {
  const { launchSiteGaHandoffEvidence, validateLaunchSiteGaHandoffEvidence } = await loadContract();
  const domains = new Set(
    launchSiteGaHandoffEvidence.releaseCutlineDependencies.map((dependency) => dependency.readinessDomain),
  );

  assert.ok(domains.has("documentation"));
  assert.ok(domains.has("productization"));
  assert.ok(domains.has("operations-readiness"));
  assert.ok(domains.has("support"));
  assert.ok(domains.has("legal-privacy"));
  assert.ok(domains.has("release-cutline"));

  const invalid = structuredClone(launchSiteGaHandoffEvidence);
  invalid.releaseCutlineDependencies = [
    {
      id: "missing-cutline-prefix",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      readinessDomain: "productization",
      cutlineCategory: "productization",
      source: "docs/design/launch-messaging-claims.md",
    },
  ];

  const result = validateLaunchSiteGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /release cutline dependencies must map at least six readiness domains/);
  assert.match(result.errors.join("\n"), /dependency must cite a v1-blocker cutline category/);
});

test("follow-up execution issues are allowed only for missing evidence and parent status is synced", async () => {
  const { launchSiteGaHandoffEvidence, validateLaunchSiteGaHandoffEvidence } = await loadContract();

  assert.equal(launchSiteGaHandoffEvidence.initiativeStatus.parentInitiative, "HoBo v1 Release Readiness");
  assert.equal(launchSiteGaHandoffEvidence.initiativeStatus.statusUpdateRequired, true);
  assert.ok(
    launchSiteGaHandoffEvidence.followUps.every((item) =>
      launchSiteGaHandoffEvidence.evidence.some(
        (evidence) => evidence.id === item.evidenceId && evidence.status === "missing",
      ),
    ),
  );

  const invalid = structuredClone(launchSiteGaHandoffEvidence);
  invalid.followUps.push({
    id: "duplicate-demo-asset-work",
    evidenceId: "ga-launch-asset-manifest",
    ownerProject: "V1 Launch Site, Messaging & Demo Assets",
    reason: "create execution work for already accepted evidence",
  });
  invalid.initiativeStatus.updateSource = "";

  const result = validateLaunchSiteGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /follow-up execution issues require missing evidence/);
  assert.match(result.errors.join("\n"), /initiative status update source is required/);
});

test("scope guards reject launch-site build, final assets, live provisioning, and unsupported GA claims", async () => {
  const { launchSiteGaHandoffEvidence, validateLaunchSiteGaHandoffEvidence } = await loadContract();
  const invalid = structuredClone(launchSiteGaHandoffEvidence);

  invalid.scopeOut.push("Build and publish the public launch site.");
  invalid.scopeOut.push("Create final launch copy, visual polish, screenshots, or final demo video.");
  invalid.scopeOut.push("Provision real cloud resources for the public launch demo.");
  invalid.publicClaimGuards.push({
    id: "production-ready-without-owner-review",
    claim: "Launch demo assets prove GA production readiness.",
    evidenceId: "release-candidate-launch-site-evidence",
    disposition: "publish",
  });

  const result = validateLaunchSiteGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /launch-site implementation is scope-out/);
  assert.match(result.errors.join("\n"), /final launch copy and assets are scope-out/);
  assert.match(result.errors.join("\n"), /real cloud resource provisioning is scope-out/);
  assert.match(result.errors.join("\n"), /GA launch claims require accepted GA handoff evidence and owner review/);
});

test("malformed evidence collections return parser errors instead of throwing", async () => {
  const { launchSiteGaHandoffEvidence, validateLaunchSiteGaHandoffEvidence } = await loadContract();
  const invalid: JsonBag = { ...asJsonObject(structuredClone(launchSiteGaHandoffEvidence)) };

  invalid.evidence = {};
  invalid.blockers = "not-blockers";
  invalid.acceptedRisks = null;
  invalid.releaseCutlineDependencies = false;
  invalid.followUps = {};
  invalid.scopeOut = {};
  invalid.publicClaimGuards = {};

  const result = validateLaunchSiteGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /M4 GA handoff evidence must contain at least six owner-mapped entries/);
  assert.match(result.errors.join("\n"), /blockers must record at least two GA handoff blockers/);
  assert.match(result.errors.join("\n"), /accepted risks must record at least two launch risk entries/);
  assert.match(result.errors.join("\n"), /release cutline dependencies must map at least six readiness domains/);
});
