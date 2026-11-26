import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import {
  POLICY_AUDIT_EVENT_SCHEMA_VERSION,
  POLICY_AUDIT_EVENT_TYPES,
  POLICY_AUDIT_RETENTION,
  REQUIRED_POLICY_AUDIT_DATA_FIELDS,
  createPolicyAuditEvent,
  createPolicyAuditFixtureEvent,
  exportPolicyEventToOcsf,
  reconstructPolicyDecision,
  sealPolicyAuditStream,
  validatePolicyAuditEvent,
  validatePolicyAuditStream,
} from "../src/policy-audit-export.js";

test("publishes the policy audit event family as retained org-scoped audit events", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../schema/policy-audit-events.v1.schema.json", import.meta.url), "utf8"),
  );

  assert.equal(POLICY_AUDIT_EVENT_SCHEMA_VERSION, "hobo.policy-audit-events/v1");
  assert.deepEqual(schema.properties.type.enum, POLICY_AUDIT_EVENT_TYPES);
  assert.deepEqual(schemaRequiredFieldsByType(schema), REQUIRED_POLICY_AUDIT_DATA_FIELDS);
  assert.equal(POLICY_AUDIT_RETENTION.neverCompact, true);

  for (const [seq, type] of POLICY_AUDIT_EVENT_TYPES.entries()) {
    const event = createPolicyAuditFixtureEvent(type, { seq: seq + 1 });
    const validation = validatePolicyAuditEvent(event);

    assert.equal(validation.ok, true, `${type}: ${validation.errors.join("\n")}`);
    assert.equal(event.retention.class, "security-audit");
    assert.equal(event.retention.neverCompact, true);
    assert.equal(event.orgId, "org:acme");
    assert.equal(event.streamId, "org:acme/policy-audit");
  }
});

test("exports policy.Decided to OCSF Authorization with reconstructable deny reason and pack version", () => {
  const event = createPolicyAuditFixtureEvent("policy.Decided", {
    seq: 1,
    data: {
      effect: "deny",
      reason: "policy pack hobo.guardrails@2026.06 blocked privileged action",
      packVersion: "hobo.guardrails@2026.06",
      packDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      policyIds: ["policy:deny-admin-without-breakglass"],
      obligations: [{ id: "obl-open-waiver", kind: "waiver.request", status: "created" }],
      violations: ["breakglass waiver required"],
    },
  });

  const ocsf = exportPolicyEventToOcsf(event);
  const reconstruction = reconstructPolicyDecision([event], event.data.decisionId);

  assert.equal(ocsf.category_name, "Identity & Access Management");
  assert.equal(ocsf.class_name, "Authorization");
  assert.equal(ocsf.activity_name, "Policy Decision");
  assert.equal(ocsf.status, "Denied");
  assert.equal(ocsf.hobo.policy.pack_version, "hobo.guardrails@2026.06");
  assert.deepEqual(ocsf.hobo.policy.policy_ids, ["policy:deny-admin-without-breakglass"]);
  assert.deepEqual(reconstruction, {
    decisionId: event.data.decisionId,
    effect: "deny",
    reason: "policy pack hobo.guardrails@2026.06 blocked privileged action",
    packVersion: "hobo.guardrails@2026.06",
    packDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    policyIds: ["policy:deny-admin-without-breakglass"],
    obligations: ["obl-open-waiver"],
    violations: ["breakglass waiver required"],
  });
});

test("maps violations, waivers, and obligation lifecycle facts without attestation export", () => {
  const classes = Object.fromEntries(
    [
      "policy.ViolationDetected",
      "policy.WaiverRequested",
      "policy.WaiverApproved",
      "policy.ObligationCreated",
      "policy.ObligationSatisfied",
      "policy.ObligationEscalated",
    ].map((type, index) => {
      const ocsf = exportPolicyEventToOcsf(createPolicyAuditFixtureEvent(type, { seq: index + 1 }));
      return [type, [ocsf.category_name, ocsf.class_name, ocsf.activity_name, ocsf.hobo.export_kind]];
    }),
  );

  assert.deepEqual(classes, {
    "policy.ViolationDetected": [
      "Identity & Access Management",
      "Authorization",
      "Policy Violation",
      "audit",
    ],
    "policy.WaiverRequested": ["Configuration", "Change", "Waiver Requested", "audit"],
    "policy.WaiverApproved": ["Configuration", "Change", "Waiver Approved", "audit"],
    "policy.ObligationCreated": ["Configuration", "Change", "Obligation Created", "audit"],
    "policy.ObligationSatisfied": ["Configuration", "Change", "Obligation Satisfied", "audit"],
    "policy.ObligationEscalated": ["Configuration", "Change", "Obligation Escalated", "audit"],
  });
});

test("requires policy pack version evidence for decisions and violations", () => {
  const decision = createPolicyAuditFixtureEvent("policy.Decided", {
    data: { packVersion: undefined },
  });
  const violation = createPolicyAuditFixtureEvent("policy.ViolationDetected", {
    data: { packVersion: "" },
  });

  assert.match(validatePolicyAuditEvent(decision).errors.join("\n"), /data.packVersion is required/);
  assert.match(validatePolicyAuditEvent(violation).errors.join("\n"), /data.packVersion is required/);
});

test("rejects plaintext PII and exports only ciphertext references or redaction markers", () => {
  const encrypted = createPolicyAuditFixtureEvent("policy.Decided", {
    data: {
      protectedSubject: {
        ciphertextRef: "vault://policy-audit/pii/user-priya",
        keyRef: "tenant-key://acme/pii/user-priya",
        algorithm: "AES-256-GCM",
      },
    },
  });
  const plaintext = createPolicyAuditEvent("policy.Decided", {
    ...encrypted.data,
    protectedSubject: undefined,
    subject: {
      email: "priya@example.com",
    },
  });

  assert.equal(validatePolicyAuditEvent(encrypted).ok, true);
  assert.equal(exportPolicyEventToOcsf(encrypted).hobo.protected_subject.ciphertext_ref, "vault://policy-audit/pii/user-priya");
  assert.equal(JSON.stringify(exportPolicyEventToOcsf(encrypted)).includes("priya@example.com"), false);
  assert.equal(
    exportPolicyEventToOcsf(encrypted, {
      destroyedKeyRefs: ["tenant-key://acme/pii/user-priya"],
    }).hobo.protected_subject.status,
    "crypto-shredded",
  );
  assert.match(
    validatePolicyAuditEvent(plaintext).errors.join("\n"),
    /data.subject.email is forbidden plaintext PII/,
  );
});

test("validates append-only retained streams and rejects tampering or compaction", () => {
  const sealed = sealPolicyAuditStream([
    createPolicyAuditFixtureEvent("policy.Decided", { seq: 1 }),
    createPolicyAuditFixtureEvent("policy.ObligationCreated", { seq: 2 }),
    createPolicyAuditFixtureEvent("policy.ObligationSatisfied", { seq: 3 }),
  ]);

  assert.deepEqual(validatePolicyAuditStream(sealed), { ok: true, errors: [] });

  const compacted = [{ ...sealed[0], retention: { ...sealed[0].retention, neverCompact: false } }];
  const wrongStreamPolicy = [
    { ...sealed[0], retention: { ...sealed[0].retention, streamPolicy: "compact-policy-audit-stream" } },
  ];
  const outOfOrder = [sealed[0], sealed[2]];
  const tampered = [
    sealed[0],
    {
      ...sealed[1],
      data: {
        ...sealed[1].data,
        obligationId: "obl-tampered-after-seal",
      },
    },
  ];

  assert.match(validatePolicyAuditStream(compacted).errors.join("\n"), /retention.neverCompact must be true/);
  assert.match(
    validatePolicyAuditStream(wrongStreamPolicy).errors.join("\n"),
    /retention.streamPolicy must be retain-org-policy-audit-stream/,
  );
  assert.match(validatePolicyAuditStream(outOfOrder).errors.join("\n"), /stream seq must increase by 1/);
  assert.match(validatePolicyAuditStream(tampered).errors.join("\n"), /contentHash mismatch/);
});

function schemaRequiredFieldsByType(schema) {
  return Object.fromEntries(
    schema.allOf.map((entry) => [entry.if.properties.type.const, entry.then.properties.data.required]),
  );
}
