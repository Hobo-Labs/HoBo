import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { asJsonObject, type JsonBag } from "../src/json.js";


const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadContract() {
  const module = await import("../src/launch-support-ga-handoff-evidence.ts").catch((error) => ({
    __loadError: error,
  }));

  assert.equal(module.__loadError, undefined, module.__loadError?.message);
  return module;
}

test("M4 GA launch support evidence is listed and mapped to owning projects", async () => {
  const {
    launchSupportGaHandoffEvidence,
    launchSupportGaHandoffEvidenceSchema,
    validateLaunchSupportGaHandoffEvidence,
  } = await loadContract();

  const result = validateLaunchSupportGaHandoffEvidence(launchSupportGaHandoffEvidence);

  assert.deepEqual(result.errors, []);
  assert.equal(launchSupportGaHandoffEvidence.schema, launchSupportGaHandoffEvidenceSchema);
  assert.equal(launchSupportGaHandoffEvidence.issue, "HOBO-481");
  assert.equal(launchSupportGaHandoffEvidence.phase, "M4");
  assert.equal(launchSupportGaHandoffEvidence.milestone, "M4 GA handoff");
  assert.ok(launchSupportGaHandoffEvidence.evidence.length >= 8);

  for (const item of launchSupportGaHandoffEvidence.evidence) {
    assert.ok(item.ownerProject, `${item.id} missing owner project`);
    assert.ok(item.source, `${item.id} missing source`);
    assert.ok(item.acceptanceBullet, `${item.id} missing acceptance mapping`);
  }
});

test("M4 GA launch support blockers and accepted risks are recorded and tied to evidence", async () => {
  const { launchSupportGaHandoffEvidence, validateLaunchSupportGaHandoffEvidence } = await loadContract();

  assert.ok(launchSupportGaHandoffEvidence.blockers.length >= 2);
  assert.ok(launchSupportGaHandoffEvidence.acceptedRisks.length >= 2);

  const evidenceIds = new Set(launchSupportGaHandoffEvidence.evidence.map((item) => item.id));
  for (const blocker of launchSupportGaHandoffEvidence.blockers) {
    assert.ok(blocker.ownerProject, `${blocker.id} missing owner`);
    assert.ok(blocker.disposition, `${blocker.id} missing disposition`);
    assert.ok(["cleared", "accepted-risk"].includes(blocker.state));
    assert.ok(evidenceIds.has(blocker.sourceEvidenceId), `${blocker.id} cites unknown evidence`);
  }

  const invalid = structuredClone(launchSupportGaHandoffEvidence);
  invalid.blockers = [];
  invalid.acceptedRisks = [];

  const result = validateLaunchSupportGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /blockers must record at least two GA support entries/);
  assert.match(result.errors.join("\n"), /accepted risks must record at least two GA support entries/);
});

test("cross-project dependencies are reflected in release cutline domains", async () => {
  const { launchSupportGaHandoffEvidence, validateLaunchSupportGaHandoffEvidence } = await loadContract();

  const domains = new Set(
    launchSupportGaHandoffEvidence.releaseCutlineDependencies.map((dependency) => dependency.readinessDomain),
  );

  assert.ok(domains.has("support"));
  assert.ok(domains.has("operations-readiness"));
  assert.ok(domains.has("incident-communications"));
  assert.ok(domains.has("security"));
  assert.ok(domains.has("release-cutline"));

  const invalid = structuredClone(launchSupportGaHandoffEvidence);
  invalid.releaseCutlineDependencies = [
    {
      id: "missing-cutline-prefix",
      ownerProject: "V1 Launch Support Desk & Escalation",
      readinessDomain: "support",
      cutlineCategory: "support",
      source: "docs/design/launch-support-escalation.md",
    },
  ];

  const result = validateLaunchSupportGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /release cutline dependencies must map at least five readiness domains/);
  assert.match(result.errors.join("\n"), /dependency must cite a v1-blocker cutline category/);
});

test("follow-up execution is limited to missing evidence and parent readiness status is synced", async () => {
  const { launchSupportGaHandoffEvidence, validateLaunchSupportGaHandoffEvidence } = await loadContract();

  assert.equal(launchSupportGaHandoffEvidence.initiativeStatus.parentInitiative, "HoBo v1 Release Readiness");
  assert.equal(launchSupportGaHandoffEvidence.initiativeStatus.statusUpdateRequired, true);
  assert.match(
    launchSupportGaHandoffEvidence.initiativeStatus.statusUpdateUrl,
    /initiative-update-bb231636/,
  );
  assert.equal(launchSupportGaHandoffEvidence.missingEvidence.length, 0);
  assert.equal(launchSupportGaHandoffEvidence.followUps.length, 0);

  const invalid = structuredClone(launchSupportGaHandoffEvidence);
  invalid.followUps.push({
    id: "HOBO-999",
    evidenceId: "ga-support-owner-signoff",
    ownerProject: "V1 Launch Support Desk & Escalation",
    reason: "create execution work for evidence that is already accepted",
  });
  invalid.initiativeStatus.updateSource = "";
  invalid.initiativeStatus.statusUpdateUrl = "";

  const result = validateLaunchSupportGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /follow-up execution issues require missing evidence/);
  assert.match(result.errors.join("\n"), /initiative status update source is required/);
  assert.match(result.errors.join("\n"), /initiative status update evidence URL is required/);
});

test("parser returns a refined immutable record and fails closed on invalid input", async () => {
  const {
    launchSupportGaHandoffEvidence,
    parseLaunchSupportGaHandoffEvidence,
    isParsedLaunchSupportGaHandoffEvidence,
  } = await loadContract();

  const parsed = parseLaunchSupportGaHandoffEvidence(launchSupportGaHandoffEvidence);

  assert.equal(isParsedLaunchSupportGaHandoffEvidence(parsed), true);
  assert.equal(Object.isFrozen(parsed), true);
  assert.notEqual(parsed, launchSupportGaHandoffEvidence);
  assert.throws(
    () => parseLaunchSupportGaHandoffEvidence({ ...launchSupportGaHandoffEvidence, schema: "wrong" }),
    /schema must be hobo\.launch-support-ga-handoff-evidence\/2026-06-30/,
  );
});

test("runtime, protobuf, CUE, and PACT schema views stay reconciled", async () => {
  const { launchSupportGaHandoffEvidenceSchema } = await loadContract();
  const proto = fs.readFileSync(
    path.join(packageRoot, "architecture", "launch_support_ga_handoff_evidence.proto"),
    "utf8",
  );
  const cue = fs.readFileSync(
    path.join(packageRoot, "architecture", "launch_support_ga_handoff_evidence.cue"),
    "utf8",
  );
  const pact = JSON.parse(
    fs.readFileSync(
      path.join(packageRoot, "architecture", "pacts", "launch_support_ga_handoff_evidence.pact.json"),
      "utf8",
    ),
  );

  assert.match(proto, /string schema = 1;/);
  assert.match(cue, new RegExp(`schema:\\s+"${launchSupportGaHandoffEvidenceSchema.replaceAll(".", "\\.")}"`));
  assert.equal(pact.interactions[0].response.body.schema, launchSupportGaHandoffEvidenceSchema);
});

test("scope guards reject support tooling, status-page publication, customer-data access, SLA, and GA claim creep", async () => {
  const { launchSupportGaHandoffEvidence, validateLaunchSupportGaHandoffEvidence } = await loadContract();

  const invalid = structuredClone(launchSupportGaHandoffEvidence);
  invalid.scopeOut.push("Implement the support ticket queue for GA customers.");
  invalid.scopeOut.push("Publish the public status page update automatically.");
  invalid.scopeOut.push("Read live customer data to debug GA support incidents.");
  invalid.scopeOut.push("Approve a customer-facing SLA response-time guarantee.");
  invalid.publicClaimGuards.push({
    id: "unsupported-ga-support-claim",
    claim: "HoBo provides 24x7 contractual GA support and unlimited customer-data troubleshooting.",
    evidenceId: "ga-support-owner-signoff",
    disposition: "publish",
  });

  const result = validateLaunchSupportGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /support ticket queue implementation is scope-out/);
  assert.match(result.errors.join("\n"), /status-page publication is scope-out/);
  assert.match(result.errors.join("\n"), /customer-data access is scope-out/);
  assert.match(result.errors.join("\n"), /customer-facing SLA approval is scope-out/);
  assert.match(result.errors.join("\n"), /unsupported public support claim/);
});

test("malformed evidence collections return parser errors instead of throwing", async () => {
  const { launchSupportGaHandoffEvidence, validateLaunchSupportGaHandoffEvidence } = await loadContract();
  const invalid: JsonBag = { ...asJsonObject(structuredClone(launchSupportGaHandoffEvidence)) };

  invalid.evidence = {};
  invalid.blockers = "not-blockers";
  invalid.acceptedRisks = null;
  invalid.releaseCutlineDependencies = false;
  invalid.missingEvidence = {};
  invalid.followUps = {};
  invalid.scopeOut = {};
  invalid.publicClaimGuards = {};

  const result = validateLaunchSupportGaHandoffEvidence(invalid);

  assert.match(result.errors.join("\n"), /evidence must be an array/);
  assert.match(result.errors.join("\n"), /blockers must be an array/);
  assert.match(result.errors.join("\n"), /release cutline dependencies must be an array/);
  assert.match(result.errors.join("\n"), /scope-out guards must be an array/);
});
