import { isJsonString, isJsonObject } from "../src/json.js";
import { createHash } from "node:crypto";

import {
  CAPABILITY_DISCOVERY_CONTRACT,
  createCapabilityDiscoveryIndex,
  createFixtureCertifiedListing,
} from "../../../technical-proofs/capability-indexed-discovery-contract/src/capability-indexed-discovery.js";
import {
  assertOriginalEventsUnchanged,
  createEventLog,
  createKeyring,
  cryptoShredSubject,
  provisionSubject,
  rebuildProjection,
} from "../../../technical-proofs/crypto-shred-erasure-contract/src/crypto-shred-erasure-contract.js";
import { evaluateDataGovernancePolicy } from "../../../technical-proofs/data-governance-policy-contract/src/data-governance-policy.js";
import { decideGuardrailStep } from "../../../technical-proofs/guardrail-policy-gate-contract/src/guardrail-policy-gate.js";
import { POLICY_IR_SCHEMA_VERSION } from "../../../technical-proofs/hobo-policy-ir-contract/src/policy-ir.js";

export const GOVERNANCE_PLANES_S6_SCHEMA = "hobo.governance-planes-s6-08/v1";
export const NOTIFY_PORT = "hobo:notify";

export const STAGE6_EVIDENCE_ITEMS = Object.freeze([
  "consent-gated-notify",
  "residency-obligation-crypto-shred",
  "blocked-flagged-model-output",
  "certified-only-registry-install",
]);

const FIXED_TS = "2026-07-02T00:00:00.000Z";

export function requestConsentGatedNotify(input) {
  const request = parseNotifyRequest(input);
  const consent = findConsent(request.consentRecords, request.recipientId);
  const events = [];

  if (!consent || consent.status !== "granted") {
    const policyDecision = {
      effect: "deny",
      reason: consent ? `consent status ${consent.status}` : "missing notify consent",
      violations: ["notify.consent-required"],
    };
    events.push(makeEvent(request, 1, "policy.Decided", {
      request: makeNotifyPolicyRequest(request),
      decision: policyDecision,
    }));
    return {
      ok: false,
      port: NOTIFY_PORT,
      reason: policyDecision.reason,
      events,
    };
  }

  events.push(makeEvent(request, 1, "policy.Decided", {
    request: makeNotifyPolicyRequest(request),
    decision: {
      effect: "allow",
      reason: "notify consent granted",
      violations: [],
    },
  }));
  events.push(makeEvent(request, 2, "notification.Requested", {
    port: NOTIFY_PORT,
    recipientId: request.recipientId,
    template: request.template,
    consentRef: consent.id,
    channel: request.channel ?? "email",
  }));
  events.push(makeEvent(request, 3, "notification.Delivered", {
    port: NOTIFY_PORT,
    recipientId: request.recipientId,
    template: request.template,
    consentRef: consent.id,
  }));

  return {
    ok: true,
    port: NOTIFY_PORT,
    events,
  };
}

export function evaluateResidencyWithCryptoShred(input) {
  const placement = parsePlacement(input);
  const governance = evaluateDataGovernancePolicy({
    request: {
      schemaVersion: POLICY_IR_SCHEMA_VERSION,
      subject: {
        kind: "agent",
        id: "agent:tenant-a/deployer",
        roles: ["deployer"],
        scopes: ["hobo:deployment:can-deploy"],
      },
      action: "hobo:deployment:can-deploy",
      resource: {
        kind: "camp",
        id: placement.campId,
      },
      phase: "plan",
      context: {
        region: placement.region,
        dataClassifications: [placement.classification],
      },
    },
    classifiedData: [{
      type: "data.Classified",
      resourceId: placement.resourceId,
      classification: placement.classification,
      jurisdiction: "US",
      allowedRegions: placement.allowedRegions,
      retention: { minDays: 2555, maxDays: 3650 },
    }],
    policy: { id: "governance:hipaa-us-residency" },
    placement: {
      campId: placement.campId,
      region: placement.region,
    },
  });

  const log = createEventLog();
  const keyring = createKeyring();
  provisionSubject(keyring, {
    subjectId: placement.subjectId,
    tenantId: placement.tenantId,
  });
  const originalEvents = structuredClone(log.events);
  cryptoShredSubject(log, keyring, {
    reason: "gdpr-request",
    subjectId: placement.subjectId,
    tenantId: placement.tenantId,
  });
  assertOriginalEventsUnchanged(originalEvents, log.events);
  const projection = rebuildProjection(log.events, keyring);

  return {
    deployable: governance.decision.effect === "allow",
    residencyEnforced: governance.decision.effect === "deny",
    governance,
    erasure: {
      projection,
      logEventCount: log.events.length,
      erasedSubject: placement.subjectId,
    },
  };
}

export function blockFlaggedModelOutput(input) {
  const run = parseGuardrailInput(input);
  return decideGuardrailStep(run);
}

export function installCertifiedListingViaMatching(input) {
  const request = parseInstallRequest(input);
  const index = createCapabilityDiscoveryIndex();

  for (const listing of request.listings) {
    index.apply(listing);
  }

  const discovery = index.find({
    port: request.port,
    criteria: request.criteria,
  });

  if (!discovery.ok || discovery.results.length === 0) {
    return {
      installed: false,
      reason: "no certified listing matches criteria",
      discovery,
    };
  }

  const selected = discovery.results[0];

  return {
    installed: true,
    listingId: selected.listingId,
    contract: CAPABILITY_DISCOVERY_CONTRACT,
    discovery,
    events: [
      {
        type: "match.Decided",
        data: {
          port: request.port,
          listingId: selected.listingId,
          criteria: request.criteria,
        },
      },
      {
        type: "registry.ListingInstalled",
        data: {
          listingId: selected.listingId,
          certificationStatus: "passed",
        },
      },
    ],
  };
}

export function runStage6GovernanceEvidenceSuite(fixtureInput = {}) {
  const fixture = normalizeSuiteFixture(fixtureInput);
  const results = {
    notify: requestConsentGatedNotify(fixture.notify),
    residencyErasure: evaluateResidencyWithCryptoShred(fixture.residency),
    guardrail: blockFlaggedModelOutput(fixture.guardrail),
    registryInstall: installCertifiedListingViaMatching(fixture.registry),
  };

  const evidence = {
    "consent-gated-notify": results.notify.ok === true,
    "residency-obligation-crypto-shred":
      results.residencyErasure.residencyEnforced === true &&
      results.residencyErasure.erasure?.projection?.erasedSubjects?.some((key) =>
        key.endsWith(`/subject/${fixture.residency.subjectId}`),
      ) === true,
    "blocked-flagged-model-output": results.guardrail.effect === "block",
    "certified-only-registry-install": results.registryInstall.installed === true,
  };

  return {
    schema: GOVERNANCE_PLANES_S6_SCHEMA,
    evidence,
    allGreen: Object.values(evidence).every(Boolean),
    results,
  };
}

function normalizeSuiteFixture(overrides) {
  return {
    notify: {
      runId: "notify-run-1",
      recipientId: "user:alice",
      template: "deployment-complete",
      channel: "email",
      consentRecords: [{
        id: "consent:alice-notify",
        recipientId: "user:alice",
        status: "granted",
        scope: "product-notifications",
      }],
      ts: FIXED_TS,
      ...overrides.notify,
    },
    residency: {
      campId: "camp:tenant-a/patient-api",
      region: "eu-central-1",
      allowedRegions: ["us-east-1"],
      classification: "phi",
      resourceId: "dataset:patient-records",
      subjectId: "alice",
      tenantId: "tenant-a",
      ...overrides.residency,
    },
    guardrail: {
      runId: "guardrail-run-1",
      outputId: "output:agent-1",
      subject: { kind: "agent", id: "agent:ops" },
      phase: "runtime",
      checks: [
        { rail: "pii", status: "fail", finding: "ssn detected in output" },
      ],
      policyEffect: "deny",
      ts: FIXED_TS,
      ...overrides.guardrail,
    },
    registry: {
      port: "wasi:blobstore/blobstore@1.0.0",
      criteria: { region: "us-east-1", classification: "public" },
      listings: [
        toCertifiedListingEvent({
          listingId: "listing-uncertified",
          providerId: "acme-uncertified",
          certificationStatus: "failed",
        }),
        toCertifiedListingEvent({
          listingId: "listing-certified",
          providerId: "acme-certified",
        }),
      ],
      ...overrides.registry,
    },
  };
}

function toCertifiedListingEvent({
  listingId,
  providerId,
  certificationStatus = "passed",
  ...rest
}) {
  return {
    type: "listing.Certified",
    occurredAt: FIXED_TS,
    listingId,
    descriptor: createFixtureCertifiedListing({ listingId, providerId, ...rest }),
    certification: {
      status: certificationStatus,
      reportRef: `oci://registry.example/reports/${listingId}@sha256:${hashFixture({ listingId }).slice(7, 71)}`,
    },
  };
}

function parseNotifyRequest(input) {
  const value = expectObject(input, "notify");
  return {
    runId: expectString(value.runId, "notify.runId"),
    recipientId: expectString(value.recipientId, "notify.recipientId"),
    template: expectString(value.template, "notify.template"),
    channel: value.channel,
    consentRecords: Array.isArray(value.consentRecords) ? value.consentRecords : [],
    ts: expectIso(value.ts, "notify.ts"),
  };
}

function parsePlacement(input) {
  const value = expectObject(input, "residency");
  return {
    campId: expectString(value.campId, "residency.campId"),
    region: expectString(value.region, "residency.region"),
    allowedRegions: expectStringArray(value.allowedRegions, "residency.allowedRegions"),
    classification: expectString(value.classification, "residency.classification"),
    resourceId: expectString(value.resourceId, "residency.resourceId"),
    subjectId: expectString(value.subjectId, "residency.subjectId"),
    tenantId: expectString(value.tenantId, "residency.tenantId"),
  };
}

function parseGuardrailInput(input) {
  const value = expectObject(input, "guardrail");
  return {
    runId: expectString(value.runId, "guardrail.runId"),
    outputId: expectString(value.outputId, "guardrail.outputId"),
    subject: value.subject,
    phase: expectString(value.phase, "guardrail.phase"),
    checks: value.checks,
    policyEffect: value.policyEffect ?? "deny",
    ts: expectIso(value.ts, "guardrail.ts"),
  };
}

function parseInstallRequest(input) {
  const value = expectObject(input, "registry");
  return {
    port: expectString(value.port, "registry.port"),
    criteria: value.criteria ?? {},
    listings: Array.isArray(value.listings) ? value.listings : [],
  };
}

function findConsent(records, recipientId) {
  return records.find((record) => record.recipientId === recipientId);
}

function makeNotifyPolicyRequest(request) {
  return {
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: { kind: "service", id: "yard:notify-dispatcher" },
    action: "notify.send",
    resource: { kind: "recipient", id: request.recipientId },
    phase: "runtime",
    context: {
      template: request.template,
      port: NOTIFY_PORT,
    },
  };
}

function makeEvent(request, seq, type, data) {
  return {
    id: `${request.runId}:${seq}:${type}`,
    type,
    v: 1,
    schemaVersion: GOVERNANCE_PLANES_S6_SCHEMA,
    streamId: `notify:${request.recipientId}`,
    seq,
    ts: request.ts,
    correlationId: request.runId,
    data,
  };
}

function expectObject(value, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function expectString(value, path) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function expectStringArray(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array`);
  }
  return value.map((item, index) => expectString(item, `${path}[${index}]`));
}

function expectIso(value, path) {
  const parsed = expectString(value, path);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new Error(`${path} must be an ISO timestamp`);
  }
  return parsed;
}

export function hashFixture(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
