import assert from "node:assert/strict";
import { test } from "vitest";
import { asJsonObject, type JsonBag } from "../src/json.js";


async function loadContract() {
  const module = await import("../src/dogfood-yard-ga-handoff-evidence.ts").catch((error) => ({
    __loadError: error,
  }));

  assert.equal(module.__loadError, undefined, module.__loadError?.message);
  return module;
}

test("M4 GA Dogfood Yard handoff evidence is listed and mapped to owning projects", async () => {
  const { dogfoodYardGaHandoffEvidence, validateDogfoodYardGaHandoffEvidence } = await loadContract();

  const result = validateDogfoodYardGaHandoffEvidence(dogfoodYardGaHandoffEvidence);

  assert.deepEqual(result.errors, []);
  assert.equal(dogfoodYardGaHandoffEvidence.issue, "HOBO-476");
  assert.equal(dogfoodYardGaHandoffEvidence.project, "V1 Dogfood Yard & Hosted Operations");
  assert.equal(dogfoodYardGaHandoffEvidence.phase, "M4");
  assert.equal(dogfoodYardGaHandoffEvidence.milestone, "M4 GA handoff");
  assert.deepEqual(
    dogfoodYardGaHandoffEvidence.evidence.map((item) => item.id),
    [
      "m0-dogfood-yard-acceptance",
      "m1-dogfood-alpha-evidence",
      "m2-private-beta-review",
      "m3-release-candidate-review",
      "hosted-broker-deploy-readiness",
      "ga-smoke-telemetry-bundle",
      "rollback-restore-support-handoff",
      "release-cutline-ga-handoff",
    ],
  );

  for (const item of dogfoodYardGaHandoffEvidence.evidence) {
    assert.ok(item.ownerProject, `${item.id} missing owner project`);
    assert.ok(item.source, `${item.id} missing source`);
    assert.ok(item.acceptanceBullet, `${item.id} missing acceptance mapping`);
  }
});

test("M4 blockers and accepted risks record in-review predecessor gates and cutline handoff state", async () => {
  const { dogfoodYardGaHandoffEvidence, validateDogfoodYardGaHandoffEvidence } = await loadContract();

  assert.ok(dogfoodYardGaHandoffEvidence.blockers.length >= 3);
  assert.ok(dogfoodYardGaHandoffEvidence.acceptedRisks.length >= 2);

  const evidenceIds = new Set(dogfoodYardGaHandoffEvidence.evidence.map((item) => item.id));
  for (const blocker of dogfoodYardGaHandoffEvidence.blockers) {
    assert.ok(blocker.ownerProject, `${blocker.id} missing owner`);
    assert.ok(["blocked", "accepted-risk", "cleared"].includes(blocker.state));
    assert.ok(evidenceIds.has(blocker.sourceEvidenceId), `${blocker.id} cites unknown evidence`);
  }

  const invalid = structuredClone(dogfoodYardGaHandoffEvidence);
  invalid.blockers = [];
  invalid.acceptedRisks = [];

  const result = validateDogfoodYardGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /blockers must record at least three Dogfood Yard GA entries/);
  assert.match(result.errors.join("\n"), /accepted risks must record at least two Dogfood Yard GA entries/);
});

test("cross-project dependencies are reflected in release cutline domains", async () => {
  const { dogfoodYardGaHandoffEvidence, validateDogfoodYardGaHandoffEvidence } = await loadContract();

  const domains = new Set(
    dogfoodYardGaHandoffEvidence.releaseCutlineDependencies.map((dependency) => dependency.readinessDomain),
  );

  assert.ok(domains.has("operations-readiness"));
  assert.ok(domains.has("release-cutline"));
  assert.ok(domains.has("support"));
  assert.ok(domains.has("documentation"));
  assert.ok(domains.has("reliability"));
  assert.ok(domains.has("bootstrap"));
  assert.ok(domains.has("broker"));

  const invalid = structuredClone(dogfoodYardGaHandoffEvidence);
  invalid.releaseCutlineDependencies = [
    {
      id: "bad-cutline-domain",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      readinessDomain: "operations-readiness",
      cutlineCategory: "operations",
      source: "docs/design/dogfood-yard.md",
    },
  ];

  const result = validateDogfoodYardGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /release cutline dependencies must map at least seven readiness domains/);
  assert.match(result.errors.join("\n"), /dependency must cite a v1-blocker cutline category/);
});

test("follow-up execution is limited to missing evidence and parent readiness status is synced", async () => {
  const { dogfoodYardGaHandoffEvidence, validateDogfoodYardGaHandoffEvidence } = await loadContract();

  assert.equal(dogfoodYardGaHandoffEvidence.initiativeStatus.parentInitiative, "HoBo v1 Release Readiness");
  assert.equal(dogfoodYardGaHandoffEvidence.initiativeStatus.statusUpdateRequired, true);
  assert.deepEqual(
    dogfoodYardGaHandoffEvidence.followUps.map((item) => item.id),
    ["HOBO-475"],
  );

  const invalid = structuredClone(dogfoodYardGaHandoffEvidence);
  invalid.followUps.push({
    id: "HOBO-999",
    evidenceId: "m0-dogfood-yard-acceptance",
    ownerProject: "V1 Dogfood Yard & Hosted Operations",
    reason: "create execution work for accepted evidence",
  });
  invalid.initiativeStatus.updateSource = "";

  const result = validateDogfoodYardGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /follow-up execution issues require missing evidence/);
  assert.match(result.errors.join("\n"), /initiative status update source is required/);
});

test("scope guards reject runtime build, live provider, customer-data, recovery, and unsupported GA claim creep", async () => {
  const { dogfoodYardGaHandoffEvidence, validateDogfoodYardGaHandoffEvidence } = await loadContract();
  const invalid = structuredClone(dogfoodYardGaHandoffEvidence);

  invalid.scopeIn.push(
    "Build hosted Yard runtime, call live provider APIs, inspect live customer data, and publish GA readiness.",
  );
  invalid.publicClaimGuards.push({
    id: "unsupported-production-restore-claim",
    claim:
      "Dogfood Yard is GA-ready with production recovery guarantees based on local fixtures and manually edited evidence.",
    evidenceId: "ga-smoke-telemetry-bundle",
    disposition: "publish",
  });

  const result = validateDogfoodYardGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /Yard runtime implementation is scope-out/);
  assert.match(result.errors.join("\n"), /live provider operations are scope-out/);
  assert.match(result.errors.join("\n"), /live customer data is scope-out/);
  assert.match(result.errors.join("\n"), /unsupported Dogfood Yard GA claim/);
  assert.match(result.errors.join("\n"), /production recovery claims require accepted drill evidence/);
});

test("malformed evidence collections return parser errors instead of throwing", async () => {
  const { dogfoodYardGaHandoffEvidence, validateDogfoodYardGaHandoffEvidence } = await loadContract();
  const invalid: JsonBag = { ...asJsonObject(structuredClone(dogfoodYardGaHandoffEvidence)) };

  invalid.evidence = {};
  invalid.blockers = "not-blockers";
  invalid.acceptedRisks = null;
  invalid.releaseCutlineDependencies = false;
  invalid.missingEvidence = {};
  invalid.followUps = {};
  invalid.scopeIn = {};
  invalid.scopeOut = {};
  invalid.publicClaimGuards = {};

  const result = validateDogfoodYardGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /evidence must be an array/);
  assert.match(result.errors.join("\n"), /blockers must be an array/);
  assert.match(result.errors.join("\n"), /release cutline dependencies must be an array/);
  assert.match(result.errors.join("\n"), /scope guards must be arrays/);
});
