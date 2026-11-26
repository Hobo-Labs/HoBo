import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createFixtureEventForType,
  createIdentityEvent,
  IDENTITY_EVENT_TYPES,
} from "../../identity-event-contract/src/identity-event-contract.js";
import { createPolicyAuditFixtureEvent } from "../../../exp-proofs/api/policy-audit-export-contract/src/policy-audit-export.js";
import {
  exportCredentialAuditChainToOcsf,
  exportIdentityAuditToOcsf,
  exportIdentityEventToOcsf,
  exportSecurityAuditEventToOcsf,
  validateIdentityOcsfMappingCoverage,
} from "../src/identity-ocsf-export.js";

const EXPECTED_CLASSES = {
  "identity.Issued": "Account Change",
  "identity.Rotated": "Account Change",
  "token.Granted": "Authorization",
  "token.Used": "Authorization",
  "token.Denied": "Authorization",
  "token.Revoked": "Authorization",
  "user.Authenticated": "Authentication",
  "session.Started": "Authentication",
  "session.Refreshed": "Authentication",
  "session.Revoked": "Authentication",
  "secret.Accessed": "Authorization",
  "config.Resolved": "Authorization",
};

test("maps every identity audit event sample to stable OCSF fields", () => {
  for (const [index, type] of IDENTITY_EVENT_TYPES.entries()) {
    const event = createFixtureEventForType(type);
    const exported = exportIdentityEventToOcsf({ ...event, seq: index + 1 });

    assert.equal(exported.schema_version, "ocsf-1.x");
    assert.equal(exported.category_name, "Identity & Access Management");
    assert.equal(exported.class_name, EXPECTED_CLASSES[type]);
    assert.equal(exported.activity_name.length > 0, true);
    assert.equal(exported.metadata.product.name, "HoBo Identity OCSF Export");
    assert.equal(exported.hobo.export_kind, "identity-audit");
    assert.equal(exported.hobo.event_id, event.id);
    assert.equal(exported.hobo.event_type, type);
    assert.equal(exported.hobo.seq, index + 1);
    assert.equal(exported.hobo.correlation_id, event.correlationId);
    assert.equal(exported.hobo.causation_id, event.causationId);
    assert.equal(Object.isFrozen(exported), true);
  }
});

test("exports policy.Decided as an auth OCSF authorization projection", () => {
  const event = createPolicyAuditFixtureEvent("policy.Decided", {
    seq: 7,
    data: {
      subjectRef: "agent:tenant-a/release",
      action: "hobo:deploy",
      resourceRef: "app:checkout",
    },
  });

  const exported = exportSecurityAuditEventToOcsf(event);

  assert.equal(exported.class_name, "Authorization");
  assert.equal(exported.activity_name, "Policy Decision");
  assert.equal(exported.hobo.export_kind, "identity-audit");
  assert.equal(exported.hobo.event_type, "policy.Decided");
  assert.equal(exported.hobo.policy.decision_id, event.data.decisionId);
});

test("exports an XAA token chain as linked OCSF authorization records", () => {
  const grant = createFixtureEventForType("token.Granted");
  const use = createFixtureEventForType("token.Used");
  const secret = createFixtureEventForType("secret.Accessed");

  const records = exportCredentialAuditChainToOcsf([
    { ...grant, id: "evt-grant", seq: 10 },
    { ...use, id: "evt-use", seq: 11, causationId: "evt-grant" },
    { ...secret, id: "evt-secret", seq: 12, causationId: "evt-use" },
  ]);

  const authorizationRecords = records.filter((record) => record.class_name === "Authorization");
  assert.equal(authorizationRecords.length, 3);
  for (const record of authorizationRecords) {
    assert.equal(record.hobo.credential_chain.id, "chain:grant-db-write");
    assert.equal(record.hobo.credential_chain.user, "user:priya");
    assert.equal(record.hobo.credential_chain.agent, "agent:release");
    assert.equal(record.hobo.credential_chain.target, "provider:acme-cloud");
  }
  assert.deepEqual(authorizationRecords[0].hobo.credential_chain.uses, ["use-db-write"]);
  assert.deepEqual(authorizationRecords[0].hobo.credential_chain.secret_refs, ["secret://prod/db-password"]);
});

test("excludes plaintext PII and only exports crypto-shred keyed ciphertext metadata", () => {
  const event = createIdentityEvent(
    "user.Authenticated",
    {
      principal: { kind: "user", id: "user:priya" },
      provider: "workos",
      authTime: "2026-06-25T10:00:00.000Z",
      sessionId: "session-priya-1",
      protectedSubject: {
        ciphertextRef: "vault://ciphertexts/users/priya/email",
        keyRef: "kms://tenant-acme/user-priya-email",
        algorithm: "aes-256-gcm",
      },
    },
    { id: "evt-auth-protected", seq: 31 },
  );

  const exported = exportIdentityEventToOcsf(event);
  const serialized = JSON.stringify(exported);

  assert.equal(exported.hobo.protected_subject.status, "crypto-shred-keyed-ciphertext");
  assert.equal(exported.hobo.protected_subject.ciphertext_ref, "vault://ciphertexts/users/priya/email");
  assert.match(exported.hobo.protected_subject.key_ref_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(serialized.includes("priya@example.com"), false);
  assert.equal(serialized.includes("kms://tenant-acme/user-priya-email"), false);

  const plaintext = createIdentityEvent(
    "user.Authenticated",
    {
      principal: { kind: "user", id: "user:priya" },
      provider: "workos",
      authTime: "2026-06-25T10:00:00.000Z",
      sessionId: "session-priya-1",
      email: "priya@example.com",
    },
    { id: "evt-auth-plaintext", seq: 32 },
  );

  assert.throws(
    () => exportIdentityEventToOcsf(plaintext),
    /forbidden; emit a ref, digest, or source marker instead/,
  );
});

test("flags OCSF mapping gaps instead of silently dropping event types", () => {
  const coverage = validateIdentityOcsfMappingCoverage([
    "identity.Issued",
    "token.Granted",
    "identity.FutureAuditEvent",
  ]);

  assert.equal(coverage.ok, false);
  assert.deepEqual(coverage.missing, ["identity.FutureAuditEvent"]);
  assert.match(coverage.errors.join("\n"), /missing OCSF mapping for identity.FutureAuditEvent/);
});

test("preserves monotonic ordering and explicitly labels unordered exports", () => {
  const ordered = exportIdentityAuditToOcsf([
    { ...createFixtureEventForType("identity.Issued"), id: "evt-1", seq: 1 },
    { ...createFixtureEventForType("token.Granted"), id: "evt-2", seq: 2, causationId: "evt-1" },
    { ...createFixtureEventForType("token.Used"), id: "evt-3", seq: 3, causationId: "evt-2" },
  ]);

  assert.deepEqual(
    ordered.map((record) => record.hobo.ordering),
    [
      { mode: "preserved", index: 0, previous_event_id: null },
      { mode: "preserved", index: 1, previous_event_id: "evt-1" },
      { mode: "preserved", index: 2, previous_event_id: "evt-2" },
    ],
  );

  const unordered = exportIdentityAuditToOcsf([
    { ...createFixtureEventForType("token.Used"), id: "evt-3", seq: 3 },
    { ...createFixtureEventForType("token.Granted"), id: "evt-2", seq: 2 },
  ]);

  assert.deepEqual(
    unordered.map((record) => record.hobo.ordering),
    [
      { mode: "unordered", index: 0, reason: "non-monotonic-seq" },
      { mode: "unordered", index: 1, reason: "non-monotonic-seq" },
    ],
  );
});
