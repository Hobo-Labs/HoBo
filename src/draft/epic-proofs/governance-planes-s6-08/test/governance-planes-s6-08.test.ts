import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  GOVERNANCE_PLANES_S6_SCHEMA,
  NOTIFY_PORT,
  STAGE6_EVIDENCE_ITEMS,
  blockFlaggedModelOutput,
  evaluateResidencyWithCryptoShred,
  installCertifiedListingViaMatching,
  requestConsentGatedNotify,
  runStage6GovernanceEvidenceSuite,
} from "../services/governance-planes-reference-architecture.js";
import { createFixtureCertifiedListing } from "../../../technical-proofs/capability-indexed-discovery-contract/src/capability-indexed-discovery.js";

const FIXED_TS = "2026-07-02T00:00:00.000Z";

describe("S6-08 governance planes stage-6 evidence", () => {
  it("passes all four stage-6 governance evidence items in the composite suite", () => {
    const suite = runStage6GovernanceEvidenceSuite();

    assert.equal(suite.schema, GOVERNANCE_PLANES_S6_SCHEMA);
    assert.equal(suite.allGreen, true);
    for (const item of STAGE6_EVIDENCE_ITEMS) {
      assert.equal(suite.evidence[item], true, item);
    }
    assert.equal(suite.results.registryInstall.listingId, "listing-certified");
  });
});

describe("consent-gated notify", () => {
  it("emits event-sourced notification.Requested only when notify consent is granted", () => {
    const result = requestConsentGatedNotify({
      runId: "notify-ok",
      recipientId: "user:alice",
      template: "deployment-complete",
      consentRecords: [{
        id: "consent:alice",
        recipientId: "user:alice",
        status: "granted",
        scope: "product-notifications",
      }],
      ts: FIXED_TS,
    });

    assert.equal(result.ok, true);
    assert.equal(result.port, NOTIFY_PORT);
    assert.deepEqual(result.events.map((event) => event.type), [
      "policy.Decided",
      "notification.Requested",
      "notification.Delivered",
    ]);
    assert.equal(result.events[1].data.consentRef, "consent:alice");
  });

  it("denies notify send without consent and records policy.Decided", () => {
    const result = requestConsentGatedNotify({
      runId: "notify-deny",
      recipientId: "user:bob",
      template: "deployment-complete",
      consentRecords: [],
      ts: FIXED_TS,
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /missing notify consent/);
    assert.deepEqual(result.events.map((event) => event.type), ["policy.Decided"]);
    assert.equal(result.events[0].data.decision.effect, "deny");
  });

  it("denies revoked consent instead of bypassing the gate", () => {
    const result = requestConsentGatedNotify({
      runId: "notify-revoked",
      recipientId: "user:carol",
      template: "deployment-complete",
      consentRecords: [{
        id: "consent:carol",
        recipientId: "user:carol",
        status: "revoked",
      }],
      ts: FIXED_TS,
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /revoked/);
  });
});

describe("enforced residency obligation with crypto-shred", () => {
  it("rejects phi placement outside permitted regions at can-deploy", () => {
    const result = evaluateResidencyWithCryptoShred({
      campId: "camp:tenant-a/patient-api",
      region: "eu-central-1",
      allowedRegions: ["us-east-1"],
      classification: "phi",
      resourceId: "dataset:patient-records",
      subjectId: "alice",
      tenantId: "tenant-a",
    });

    assert.equal(result.deployable, false);
    assert.equal(result.residencyEnforced, true);
    assert.equal(result.governance.decision.effect, "deny");
    assert.match(result.governance.decision.reason, /residency/);
  });

  it("crypto-shreds subject keys without rewriting prior log events", () => {
    const result = evaluateResidencyWithCryptoShred({
      campId: "camp:tenant-a/patient-api",
      region: "eu-central-1",
      allowedRegions: ["us-east-1"],
      classification: "phi",
      resourceId: "dataset:patient-records",
      subjectId: "alice",
      tenantId: "tenant-a",
    });

    assert.ok(result.erasure.logEventCount >= 2);
    assert.deepEqual(result.erasure.projection.erasedSubjects, ["tenant/tenant-a/subject/alice"]);
    assert.equal(Object.keys(result.erasure.projection.customers).length, 0);
  });
});

describe("blocked flagged model output", () => {
  it("blocks operator agent output when guardrail flags PII in the buffered window", () => {
    const result = blockFlaggedModelOutput({
      runId: "guardrail-1",
      outputId: "output:agent-ops",
      subject: { kind: "agent", id: "agent:ops" },
      phase: "runtime",
      checks: [
        { rail: "pii", status: "fail", finding: "ssn detected in output" },
      ],
      policyEffect: "deny",
      ts: FIXED_TS,
    });

    assert.equal(result.effect, "block");
    assert.equal(result.policyDecision.effect, "deny");
    assert.deepEqual(result.events.map((event) => event.type), [
      "policy.Decided",
      "guardrail.Blocked",
    ]);
    assert.equal(result.events[1].data.outputReleased, false);
  });

  it("fails closed when guardrail checker errors", () => {
    const result = blockFlaggedModelOutput({
      runId: "guardrail-error",
      outputId: "output:agent-ops",
      subject: { kind: "agent", id: "agent:ops" },
      phase: "runtime",
      checks: [
        { rail: "jailbreak", status: "error", finding: "checker unavailable" },
      ],
      ts: FIXED_TS,
    });

    assert.equal(result.effect, "block");
    assert.equal(result.policyDecision.effect, "deny");
  });
});

describe("certified-only Registry install via Matching", () => {
  function certifiedListing(listingId, providerId) {
    return {
      type: "listing.Certified",
      occurredAt: FIXED_TS,
      listingId,
      descriptor: createFixtureCertifiedListing({ listingId, providerId }),
      certification: {
        status: "passed",
        reportRef: `oci://registry.example/reports/${listingId}@sha256:1111111111111111111111111111111111111111111111111111111111111111`,
      },
    };
  }

  it("installs only certified listings selected by Matching discovery", () => {
    const result = installCertifiedListingViaMatching({
      port: "wasi:blobstore/blobstore@1.0.0",
      criteria: { region: "us-east-1", classification: "public" },
      listings: [certifiedListing("listing-certified", "acme-certified")],
    });

    assert.equal(result.installed, true);
    assert.equal(result.listingId, "listing-certified");
    assert.deepEqual(result.events.map((event) => event.type), [
      "match.Decided",
      "registry.ListingInstalled",
    ]);
  });

  it("never installs uncertified or failed-certification listings", () => {
    const result = installCertifiedListingViaMatching({
      port: "wasi:blobstore/blobstore@1.0.0",
      criteria: { region: "us-east-1", classification: "public" },
      listings: [{
        type: "listing.Certified",
        occurredAt: FIXED_TS,
        listingId: "listing-failed",
        descriptor: createFixtureCertifiedListing({ listingId: "listing-failed" }),
        certification: { status: "failed" },
      }],
    });

    assert.equal(result.installed, false);
    assert.match(result.reason, /no certified listing/);
  });
});
