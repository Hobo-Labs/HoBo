import assert from "node:assert/strict";
import { test } from "vitest";
import { asJsonObject, type JsonBag } from "../src/json.js";


async function loadContract() {
  const module = await import("../src/beta-pilot-ga-handoff-evidence.ts").catch((error) => ({
    __loadError: error,
  }));

  assert.equal(module.__loadError, undefined, module.__loadError?.message);
  return module;
}

test("M4 beta pilot GA handoff evidence is listed and mapped to owning projects", async () => {
  const { betaPilotGaHandoffEvidence, validateBetaPilotGaHandoffEvidence } = await loadContract();
  const result = validateBetaPilotGaHandoffEvidence(betaPilotGaHandoffEvidence);

  assert.deepEqual(result.errors, []);
  assert.equal(betaPilotGaHandoffEvidence.issue, "HOBO-477");
  assert.equal(betaPilotGaHandoffEvidence.phase, "M4");
  assert.equal(betaPilotGaHandoffEvidence.milestone, "M4 GA handoff");
  assert.ok(betaPilotGaHandoffEvidence.evidence.length >= 6);

  for (const item of betaPilotGaHandoffEvidence.evidence) {
    assert.ok(item.ownerProject, `${item.id} missing owner project`);
    assert.ok(item.source, `${item.id} missing source`);
    assert.ok(item.acceptanceBullet, `${item.id} missing acceptance mapping`);
  }
});

test("GA handoff blockers and accepted risks are recorded and tied to evidence", async () => {
  const { betaPilotGaHandoffEvidence, validateBetaPilotGaHandoffEvidence } = await loadContract();

  assert.ok(betaPilotGaHandoffEvidence.blockers.length >= 2);
  assert.ok(betaPilotGaHandoffEvidence.acceptedRisks.length >= 2);

  const evidenceIds = new Set(betaPilotGaHandoffEvidence.evidence.map((item) => item.id));
  for (const blocker of betaPilotGaHandoffEvidence.blockers) {
    assert.ok(blocker.ownerProject, `${blocker.id} missing owner`);
    assert.ok(blocker.disposition, `${blocker.id} missing disposition`);
    assert.ok(["blocked", "accepted-risk", "cleared"].includes(blocker.state));
    assert.ok(evidenceIds.has(blocker.sourceEvidenceId), `${blocker.id} cites unknown evidence`);
  }

  const invalid = structuredClone(betaPilotGaHandoffEvidence);
  invalid.blockers = [];
  invalid.acceptedRisks = [];

  const result = validateBetaPilotGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /blockers must record at least two GA handoff entries/);
  assert.match(result.errors.join("\n"), /accepted risks must record at least two GA handoff entries/);
});

test("cross-project dependencies are reflected in release cutline domains", async () => {
  const { betaPilotGaHandoffEvidence, validateBetaPilotGaHandoffEvidence } = await loadContract();
  const domains = new Set(
    betaPilotGaHandoffEvidence.releaseCutlineDependencies.map((dependency) => dependency.readinessDomain),
  );

  assert.ok(domains.has("documentation"));
  assert.ok(domains.has("productization"));
  assert.ok(domains.has("operations-readiness"));
  assert.ok(domains.has("support"));
  assert.ok(domains.has("release-cutline"));

  const invalid = structuredClone(betaPilotGaHandoffEvidence);
  invalid.releaseCutlineDependencies = [
    {
      id: "missing-cutline-prefix",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      readinessDomain: "productization",
      cutlineCategory: "productization",
      source: "docs/design/beta-pilot-feedback.md",
    },
  ];

  const result = validateBetaPilotGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /release cutline dependencies must map at least five readiness domains/);
  assert.match(result.errors.join("\n"), /dependency must cite a v1-blocker cutline category/);
});

test("follow-up execution issues are allowed only for missing evidence and parent status is synced", async () => {
  const { betaPilotGaHandoffEvidence, validateBetaPilotGaHandoffEvidence } = await loadContract();

  assert.equal(betaPilotGaHandoffEvidence.initiativeStatus.parentInitiative, "HoBo v1 Release Readiness");
  assert.equal(betaPilotGaHandoffEvidence.initiativeStatus.statusUpdateRequired, true);
  assert.ok(
    betaPilotGaHandoffEvidence.followUps.every((item) =>
      betaPilotGaHandoffEvidence.evidence.some(
        (evidence) => evidence.id === item.evidenceId && evidence.status === "missing",
      ),
    ),
  );

  const invalid = structuredClone(betaPilotGaHandoffEvidence);
  invalid.followUps.push({
    id: "duplicate-accepted-feedback-work",
    evidenceId: "ga-feedback-summary",
    ownerProject: "V1 Beta Pilot & Feedback Loop",
    reason: "create execution work for already accepted evidence",
  });
  invalid.initiativeStatus.updateSource = "";

  const result = validateBetaPilotGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /follow-up execution issues require missing evidence/);
  assert.match(result.errors.join("\n"), /initiative status update source is required/);
});

test("scope guards reject beta operations, support tooling, unresolved blockers, and unsupported GA claims", async () => {
  const { betaPilotGaHandoffEvidence, validateBetaPilotGaHandoffEvidence } = await loadContract();
  const invalid = structuredClone(betaPilotGaHandoffEvidence);

  invalid.scopeOut.push("Onboard the next beta customer cohort.");
  invalid.scopeOut.push("Implement the beta feedback portal and support ticketing workflow.");
  invalid.scopeOut.push("Resolve launch blockers inside this GA handoff proof.");
  invalid.publicClaimGuards.push({
    id: "ga-ready-with-open-blockers",
    claim: "Beta pilot feedback proves GA readiness while unresolved blockers remain.",
    evidenceId: "release-candidate-evidence",
    disposition: "publish",
  });

  const result = validateBetaPilotGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /beta customer onboarding is scope-out/);
  assert.match(result.errors.join("\n"), /feedback portal or support tooling implementation is scope-out/);
  assert.match(result.errors.join("\n"), /launch blocker resolution is scope-out/);
  assert.match(result.errors.join("\n"), /GA beta pilot claims require accepted GA handoff evidence and no unresolved blockers/);
});

test("malformed evidence collections return parser errors instead of throwing", async () => {
  const { betaPilotGaHandoffEvidence, validateBetaPilotGaHandoffEvidence } = await loadContract();
  const invalid: JsonBag = { ...asJsonObject(structuredClone(betaPilotGaHandoffEvidence)) };

  invalid.evidence = {};
  invalid.blockers = "not-blockers";
  invalid.acceptedRisks = null;
  invalid.releaseCutlineDependencies = false;
  invalid.followUps = {};
  invalid.scopeOut = {};
  invalid.publicClaimGuards = {};

  const result = validateBetaPilotGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /M4 beta pilot GA handoff evidence must contain at least six owner-mapped entries/);
  assert.match(result.errors.join("\n"), /blockers must be an array/);
  assert.match(result.errors.join("\n"), /accepted risks must be an array/);
  assert.match(result.errors.join("\n"), /release cutline dependencies must be an array/);
});
