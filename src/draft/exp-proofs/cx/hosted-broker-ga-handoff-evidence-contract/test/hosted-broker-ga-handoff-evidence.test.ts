import assert from "node:assert/strict";
import { test } from "vitest";
import { type JsonValue } from "../src/json.js";


const contract = await import("../src/hosted-broker-ga-handoff-evidence.ts").catch(() => null);

test("GA handoff proof records broker owners, proof sources, and operational checklist", () => {
  assert.ok(contract, "hosted broker GA handoff module should exist");

  const { HOSTED_BROKER_GA_HANDOFF_EVIDENCE, parseHostedBrokerGaHandoffEvidence } = contract;

  const parsed = parseHostedBrokerGaHandoffEvidence(HOSTED_BROKER_GA_HANDOFF_EVIDENCE);

  assert.equal(parsed.parsedHostedBrokerGaHandoffEvidence, true);
  assert.equal(HOSTED_BROKER_GA_HANDOFF_EVIDENCE.issue, "HOBO-530");
  assert.equal(HOSTED_BROKER_GA_HANDOFF_EVIDENCE.project, "Meta-cloud Broker");
  assert.equal(HOSTED_BROKER_GA_HANDOFF_EVIDENCE.phase, "M4");
  assert.match(HOSTED_BROKER_GA_HANDOFF_EVIDENCE.milestoneGate, /GA handoff/i);
  assert.deepEqual(
    HOSTED_BROKER_GA_HANDOFF_EVIDENCE.requiredEvidence.map((evidence: { id: string }) => evidence.id),
    [
      "operational-owner-checklist",
      "dogfood-yard-readiness-link",
      "compatibility-versioning-window",
      "rollback-restore-limits",
      "release-notes-support-entry",
    ],
  );
});

test("Dogfood Yard evidence links broker receipts to deploy readiness without becoming live GA proof", () => {
  assert.ok(contract, "hosted broker GA handoff module should exist");

  const { HOSTED_BROKER_GA_HANDOFF_EVIDENCE } = contract;

  assert.ok(
    HOSTED_BROKER_GA_HANDOFF_EVIDENCE.dogfoodReadinessLinks.some(
      (link: { artifact: string; deployReadinessUse: string; gaBoundary: string }) =>
        /Resolution Receipt/i.test(link.artifact) &&
        /deploy/i.test(link.deployReadinessUse) &&
        /not live hosted broker/i.test(link.gaBoundary),
    ),
  );
  assert.ok(
    HOSTED_BROKER_GA_HANDOFF_EVIDENCE.dogfoodReadinessLinks.some(
      (link: { artifact: string }) => /Resolution Rejection/i.test(link.artifact),
    ),
  );
});

test("GA handoff maps compatibility, versioning, rollback, release notes, and support docs", () => {
  assert.ok(contract, "hosted broker GA handoff module should exist");

  const { HOSTED_BROKER_GA_HANDOFF_EVIDENCE } = contract;

  assert.deepEqual(
    HOSTED_BROKER_GA_HANDOFF_EVIDENCE.compatibilityWindows.map((window: { id: string }) => window.id),
    ["receipt-schema-v1", "broker-environment-snapshot", "catalog-snapshot-version"],
  );
  assert.ok(
    HOSTED_BROKER_GA_HANDOFF_EVIDENCE.releaseAndSupportDocs.some(
      (doc: { ownerProject: string; brokerEntry: string }) =>
        doc.ownerProject === "V1 Release Notes & Upgrade Guide" && /broker/i.test(doc.brokerEntry),
    ),
  );
  assert.ok(
    HOSTED_BROKER_GA_HANDOFF_EVIDENCE.releaseAndSupportDocs.some(
      (doc: { ownerProject: string; brokerEntry: string }) =>
        doc.ownerProject === "V1 Launch Support Desk & Escalation" && /debug/i.test(doc.brokerEntry),
    ),
  );
});

test("adversarial parser rejects local-fixture-only GA claims and manually edited receipts", () => {
  assert.ok(contract, "hosted broker GA handoff module should exist");

  const {
    HOSTED_BROKER_GA_HANDOFF_EVIDENCE,
    HostedBrokerGaHandoffEvidenceParseError,
    parseHostedBrokerGaHandoffEvidence,
  } = contract;

  assert.throws(
    () =>
      parseHostedBrokerGaHandoffEvidence({
        ...HOSTED_BROKER_GA_HANDOFF_EVIDENCE,
        gaClaims: [
          ...HOSTED_BROKER_GA_HANDOFF_EVIDENCE.gaClaims,
          {
            id: "invalid-local-fixture-ga",
            claim: "Hosted broker is GA-ready based only on local fixtures and manually edited receipts.",
            sourceEvidenceIds: ["dogfood-yard-readiness-link"],
            disposition: "publish",
          },
        ],
      }),
    (error: JsonValue) => {
      assert.equal(error instanceof HostedBrokerGaHandoffEvidenceParseError, true);
      const details = error instanceof HostedBrokerGaHandoffEvidenceParseError ? error.errors.join("\n") : String(error);
      assert.match(details, /local fixtures/i);
      assert.match(details, /manually edited receipts/i);
      assert.match(details, /GA claim/i);
      return true;
    },
  );
});

test("follow-up creation is limited to missing post-GA evidence", () => {
  assert.ok(contract, "hosted broker GA handoff module should exist");

  const { HOSTED_BROKER_GA_HANDOFF_EVIDENCE } = contract;

  assert.equal(HOSTED_BROKER_GA_HANDOFF_EVIDENCE.followUpPolicy.createOnlyWhereEvidenceMissing, true);
  assert.equal(
    HOSTED_BROKER_GA_HANDOFF_EVIDENCE.followUpIssues.every(
      (followUp: { missingEvidenceId: string }) =>
        HOSTED_BROKER_GA_HANDOFF_EVIDENCE.missingEvidence.some(
          (missing: { id: string }) => missing.id === followUp.missingEvidenceId,
        ),
    ),
    true,
  );
});
