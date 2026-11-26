import assert from "node:assert/strict";
import { test } from "vitest";
import { asJsonObject, type JsonBag } from "../src/json.js";


async function loadContract() {
  const module = await import("../src/legal-privacy-ga-handoff-evidence.ts").catch((error) => ({
    __loadError: error,
  }));

  assert.equal(module.__loadError, undefined, module.__loadError?.message);
  return module;
}

test("M4 GA legal/privacy evidence is listed and mapped to owning projects", async () => {
  const { legalPrivacyGaHandoffEvidence, validateLegalPrivacyGaHandoffEvidence } = await loadContract();

  const result = validateLegalPrivacyGaHandoffEvidence(legalPrivacyGaHandoffEvidence);

  assert.deepEqual(result.errors, []);
  assert.equal(legalPrivacyGaHandoffEvidence.issue, "HOBO-478");
  assert.equal(legalPrivacyGaHandoffEvidence.phase, "M4");
  assert.equal(legalPrivacyGaHandoffEvidence.milestone, "M4 GA handoff");
  assert.ok(legalPrivacyGaHandoffEvidence.evidence.length >= 7);

  for (const item of legalPrivacyGaHandoffEvidence.evidence) {
    assert.ok(item.ownerProject, `${item.id} missing owner project`);
    assert.ok(item.source, `${item.id} missing source`);
    assert.ok(item.acceptanceBullet, `${item.id} missing acceptance mapping`);
  }
});

test("M4 GA legal/privacy blockers and accepted risks are recorded and tied to evidence", async () => {
  const { legalPrivacyGaHandoffEvidence, validateLegalPrivacyGaHandoffEvidence } = await loadContract();

  assert.ok(legalPrivacyGaHandoffEvidence.blockers.length >= 2);
  assert.ok(legalPrivacyGaHandoffEvidence.acceptedRisks.length >= 2);

  const evidenceIds = new Set(legalPrivacyGaHandoffEvidence.evidence.map((item) => item.id));
  for (const blocker of legalPrivacyGaHandoffEvidence.blockers) {
    assert.ok(blocker.ownerProject, `${blocker.id} missing owner`);
    assert.ok(blocker.disposition, `${blocker.id} missing disposition`);
    assert.ok(["cleared", "accepted-risk"].includes(blocker.state));
    assert.ok(evidenceIds.has(blocker.sourceEvidenceId), `${blocker.id} cites unknown evidence`);
  }

  const invalid = structuredClone(legalPrivacyGaHandoffEvidence);
  invalid.blockers = [];
  invalid.acceptedRisks = [];

  const result = validateLegalPrivacyGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /blockers must record at least two GA legal\/privacy entries/);
  assert.match(result.errors.join("\n"), /accepted risks must record at least two GA legal\/privacy entries/);
});

test("cross-project dependencies are reflected in release cutline domains", async () => {
  const { legalPrivacyGaHandoffEvidence, validateLegalPrivacyGaHandoffEvidence } = await loadContract();

  const domains = new Set(
    legalPrivacyGaHandoffEvidence.releaseCutlineDependencies.map((dependency) => dependency.readinessDomain),
  );

  assert.ok(domains.has("legal"));
  assert.ok(domains.has("privacy"));
  assert.ok(domains.has("customer-assurance"));
  assert.ok(domains.has("security"));
  assert.ok(domains.has("release-cutline"));

  const invalid = structuredClone(legalPrivacyGaHandoffEvidence);
  invalid.releaseCutlineDependencies = [
    {
      id: "missing-cutline-prefix",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      readinessDomain: "legal",
      cutlineCategory: "legal",
      source: "docs/design/legal-privacy-terms-readiness.md",
    },
  ];

  const result = validateLegalPrivacyGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /release cutline dependencies must map at least five readiness domains/);
  assert.match(result.errors.join("\n"), /dependency must cite a v1-blocker cutline category/);
});

test("follow-up execution is limited to missing evidence and parent readiness status is synced", async () => {
  const { legalPrivacyGaHandoffEvidence, validateLegalPrivacyGaHandoffEvidence } = await loadContract();

  assert.equal(legalPrivacyGaHandoffEvidence.initiativeStatus.parentInitiative, "HoBo v1 Release Readiness");
  assert.equal(legalPrivacyGaHandoffEvidence.initiativeStatus.statusUpdateRequired, true);
  assert.equal(legalPrivacyGaHandoffEvidence.missingEvidence.length, 0);
  assert.equal(legalPrivacyGaHandoffEvidence.followUps.length, 0);

  const invalid = structuredClone(legalPrivacyGaHandoffEvidence);
  invalid.followUps.push({
    id: "HOBO-999",
    evidenceId: "ga-final-terms-signoff",
    ownerProject: "V1 Legal, Privacy & Terms Readiness",
    reason: "create execution work for evidence that is already accepted",
  });
  invalid.initiativeStatus.updateSource = "";

  const result = validateLegalPrivacyGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /follow-up execution issues require missing evidence/);
  assert.match(result.errors.join("\n"), /initiative status update source is required/);
});

test("scope guards reject legal drafting, legal workflow, billing, unsupported compliance, and all-region claim creep", async () => {
  const { legalPrivacyGaHandoffEvidence, validateLegalPrivacyGaHandoffEvidence } = await loadContract();

  const invalid = structuredClone(legalPrivacyGaHandoffEvidence);
  invalid.scopeOut.push("Draft final customer terms and DPA text inside this proof package.");
  invalid.scopeOut.push("Implement a legal contract lifecycle workflow for GA customers.");
  invalid.scopeOut.push("Enable billing and paid launch commercial terms.");
  invalid.publicClaimGuards.push({
    id: "unsupported-compliance-claim",
    claim: "HoBo is SOC2 certified, GDPR compliant, and approved for all regions.",
    evidenceId: "security-privacy-claim-review",
    disposition: "publish",
  });

  const result = validateLegalPrivacyGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /final legal drafting is scope-out/);
  assert.match(result.errors.join("\n"), /legal workflow implementation is scope-out/);
  assert.match(result.errors.join("\n"), /billing or paid launch enablement is scope-out/);
  assert.match(result.errors.join("\n"), /unsupported public legal\/privacy claim/);
});

test("malformed evidence collections return parser errors instead of throwing", async () => {
  const { legalPrivacyGaHandoffEvidence, validateLegalPrivacyGaHandoffEvidence } = await loadContract();
  const invalid: JsonBag = { ...asJsonObject(structuredClone(legalPrivacyGaHandoffEvidence)) };

  invalid.evidence = {};
  invalid.blockers = "not-blockers";
  invalid.acceptedRisks = null;
  invalid.releaseCutlineDependencies = false;
  invalid.missingEvidence = {};
  invalid.followUps = {};
  invalid.scopeOut = {};
  invalid.publicClaimGuards = {};

  const result = validateLegalPrivacyGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /evidence must be an array/);
  assert.match(result.errors.join("\n"), /blockers must be an array/);
  assert.match(result.errors.join("\n"), /release cutline dependencies must be an array/);
  assert.match(result.errors.join("\n"), /scope-out guards must be an array/);
});
