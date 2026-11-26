import { createHash } from "node:crypto";
import { isJsonString, isJsonNumber, isJsonBoolean, isJsonObject } from "./json.js";


export const POLICY_AUDIT_EVENT_SCHEMA_VERSION = "hobo.policy-audit-events/v1";

export const POLICY_AUDIT_EVENT_TYPES = Object.freeze([
  "policy.Decided",
  "policy.ViolationDetected",
  "policy.WaiverRequested",
  "policy.WaiverApproved",
  "policy.ObligationCreated",
  "policy.ObligationSatisfied",
  "policy.ObligationEscalated",
]);

export const POLICY_AUDIT_RETENTION = deepFreeze({
  class: "security-audit",
  neverCompact: true,
  streamPolicy: "retain-org-policy-audit-stream",
});

const EVENT_TYPE_SET = new Set(POLICY_AUDIT_EVENT_TYPES);
const EFFECTS = new Set(["allow", "allow-degraded", "deny", "warn", "mutate", "require-approval"]);
const INITIAL_HASH = `sha256:${"0".repeat(64)}`;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_PII_KEYS = new Set([
  "email",
  "fullName",
  "phone",
  "plaintextPii",
  "rawPii",
  "ssn",
]);

export const REQUIRED_POLICY_AUDIT_DATA_FIELDS = deepFreeze({
  "policy.Decided": ["decisionId", "effect", "reason", "packVersion", "packDigest", "policyIds"],
  "policy.ViolationDetected": [
    "decisionId",
    "violationId",
    "reason",
    "packVersion",
    "packDigest",
    "policyIds",
  ],
  "policy.WaiverRequested": ["decisionId", "waiverId", "reason", "packVersion", "packDigest", "policyIds"],
  "policy.WaiverApproved": ["decisionId", "waiverId", "approvedBy", "packVersion", "packDigest", "policyIds"],
  "policy.ObligationCreated": [
    "decisionId",
    "obligationId",
    "kind",
    "status",
    "packVersion",
    "packDigest",
    "policyIds",
  ],
  "policy.ObligationSatisfied": [
    "decisionId",
    "obligationId",
    "kind",
    "status",
    "packVersion",
    "packDigest",
    "policyIds",
  ],
  "policy.ObligationEscalated": [
    "decisionId",
    "obligationId",
    "kind",
    "status",
    "reason",
    "packVersion",
    "packDigest",
    "policyIds",
  ],
});

const OCSF_MAPPING = deepFreeze({
  "policy.Decided": {
    category_uid: 3,
    category_name: "Identity & Access Management",
    class_uid: 3004,
    class_name: "Authorization",
    activity_id: 1,
    activity_name: "Policy Decision",
  },
  "policy.ViolationDetected": {
    category_uid: 3,
    category_name: "Identity & Access Management",
    class_uid: 3004,
    class_name: "Authorization",
    activity_id: 2,
    activity_name: "Policy Violation",
  },
  "policy.WaiverRequested": {
    category_uid: 9,
    category_name: "Configuration",
    class_uid: 9001,
    class_name: "Change",
    activity_id: 1,
    activity_name: "Waiver Requested",
  },
  "policy.WaiverApproved": {
    category_uid: 9,
    category_name: "Configuration",
    class_uid: 9001,
    class_name: "Change",
    activity_id: 2,
    activity_name: "Waiver Approved",
  },
  "policy.ObligationCreated": {
    category_uid: 9,
    category_name: "Configuration",
    class_uid: 9001,
    class_name: "Change",
    activity_id: 3,
    activity_name: "Obligation Created",
  },
  "policy.ObligationSatisfied": {
    category_uid: 9,
    category_name: "Configuration",
    class_uid: 9001,
    class_name: "Change",
    activity_id: 4,
    activity_name: "Obligation Satisfied",
  },
  "policy.ObligationEscalated": {
    category_uid: 9,
    category_name: "Configuration",
    class_uid: 9001,
    class_name: "Change",
    activity_id: 5,
    activity_name: "Obligation Escalated",
  },
});

export function createPolicyAuditEvent(type, data, overrides = {}) {
  return deepFreeze({
    id: overrides.id ?? `evt-${slug(type)}-${overrides.seq ?? 1}`,
    type,
    schemaVersion: POLICY_AUDIT_EVENT_SCHEMA_VERSION,
    orgId: overrides.orgId ?? "org:acme",
    tenant: overrides.tenant ?? "tenant-acme",
    streamId: overrides.streamId ?? `${overrides.orgId ?? "org:acme"}/policy-audit`,
    seq: overrides.seq ?? 1,
    time: overrides.time ?? "2026-06-26T12:00:00.000Z",
    actor: clone(overrides.actor ?? { kind: "service", id: "yard/policy-plane" }),
    correlationId: overrides.correlationId ?? "corr-policy-audit",
    causationId: overrides.causationId ?? "cmd-policy-audit",
    retention: clone(overrides.retention ?? POLICY_AUDIT_RETENTION),
    data: clone(data ?? {}),
  });
}

export function createPolicyAuditFixtureEvent(type, overrides = {}) {
  const data = {
    ...fixtureData(type),
    ...(overrides.data),
  };
  return createPolicyAuditEvent(type, data, overrides);
}

export function validatePolicyAuditEvent(event) {
  const errors = [];

  if (!isPlainObject(event)) {
    return { ok: false, errors: ["event must be an object"] };
  }

  requireString(event.id, "id", errors);
  requireString(event.type, "type", errors);
  if (!EVENT_TYPE_SET.has(event.type)) {
    errors.push(`type ${String(event.type)} is not a policy audit event`);
  }
  if (event.schemaVersion !== POLICY_AUDIT_EVENT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${POLICY_AUDIT_EVENT_SCHEMA_VERSION}`);
  }
  requireString(event.orgId, "orgId", errors);
  requireString(event.tenant, "tenant", errors);
  requireString(event.streamId, "streamId", errors);
  if (isJsonString(event.streamId) && isJsonString(event.orgId)) {
    if (!event.streamId.startsWith(`${event.orgId}/`)) {
      errors.push("streamId must be scoped under orgId");
    }
  }
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) {
    errors.push("seq must be a positive safe integer");
  }
  requireIso(event.time, "time", errors);
  validatePrincipal(event.actor, "actor", errors);
  requireString(event.correlationId, "correlationId", errors);
  requireString(event.causationId, "causationId", errors);
  validateRetention(event.retention, errors);
  validateData(event.type, event.data, errors);

  return { ok: errors.length === 0, errors };
}

export function exportPolicyEventToOcsf(event, options = {}) {
  const validation = validatePolicyAuditEvent(event);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }

  const mapping = OCSF_MAPPING[event.type];
  const data = event.data;
  const policy = {
    decision_id: data.decisionId,
    effect: data.effect ?? null,
    reason: data.reason ?? null,
    pack_version: data.packVersion,
    pack_digest: data.packDigest,
    policy_ids: [...data.policyIds],
    violation_ids: data.violationId ? [data.violationId] : [],
    violations: data.violations ?? [],
    obligation_ids: obligationIds(data),
  };

  const exported = {
    schema_version: "ocsf-1.x",
    time: Date.parse(event.time),
    severity_id: event.type === "policy.ViolationDetected" ? 3 : 1,
    status: statusForEvent(event),
    message: messageForEvent(event),
    metadata: {
      version: "1.0.0",
      product: {
        name: "HoBo Policy Audit Export",
        vendor_name: "HoBo",
      },
    },
    category_uid: mapping.category_uid,
    category_name: mapping.category_name,
    class_uid: mapping.class_uid,
    class_name: mapping.class_name,
    activity_id: mapping.activity_id,
    activity_name: mapping.activity_name,
    type_uid: mapping.class_uid * 100 + mapping.activity_id,
    actor: {
      type: event.actor.kind,
      uid: event.actor.id,
    },
    api: {
      operation: data.action ?? event.type,
    },
    resources: data.resourceRef ? [{ uid: data.resourceRef }] : [],
    hobo: {
      export_kind: "audit",
      event_id: event.id,
      event_type: event.type,
      org_id: event.orgId,
      tenant: event.tenant,
      stream_id: event.streamId,
      seq: event.seq,
      correlation_id: event.correlationId,
      causation_id: event.causationId,
      policy,
    },
  };

  const protectedSubject = renderProtectedSubject(data.protectedSubject, options.destroyedKeyRefs ?? []);
  if (protectedSubject) {
    exported.hobo.protected_subject = protectedSubject;
  }

  return deepFreeze(exported);
}

export function reconstructPolicyDecision(events, decisionId) {
  const decision = events.find(
    (event) => event.type === "policy.Decided" && event.data?.decisionId === decisionId,
  );
  if (!decision) {
    throw new Error(`policy.Decided not found for decisionId ${decisionId}`);
  }
  const validation = validatePolicyAuditEvent(decision);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }

  return deepFreeze({
    decisionId,
    effect: decision.data.effect,
    reason: decision.data.reason,
    packVersion: decision.data.packVersion,
    packDigest: decision.data.packDigest,
    policyIds: [...decision.data.policyIds],
    obligations: obligationIds(decision.data),
    violations: [...(decision.data.violations ?? [])],
  });
}

export function sealPolicyAuditStream(events) {
  let previousHash = INITIAL_HASH;
  return deepFreeze(
    events.map((event) => {
      const sealed = {
        ...clone(event),
        integrity: {
          prevHash: previousHash,
          contentHash: hashEvent(event, previousHash),
        },
      };
      previousHash = sealed.integrity.contentHash;
      return sealed;
    }),
  );
}

export function validatePolicyAuditStream(events) {
  const errors = [];

  if (!Array.isArray(events)) {
    return { ok: false, errors: ["stream must be an array"] };
  }

  let previous = null;
  let expectedPrevHash = INITIAL_HASH;
  for (const [index, event] of events.entries()) {
    const validation = validatePolicyAuditEvent(event);
    errors.push(...validation.errors.map((error) => `event[${index}]: ${error}`));

    if (previous) {
      if (event.orgId !== previous.orgId) {
        errors.push(`event[${index}]: orgId must not change within an audit stream`);
      }
      if (event.streamId !== previous.streamId) {
        errors.push(`event[${index}]: streamId must not change within an audit stream`);
      }
      if (event.seq !== previous.seq + 1) {
        errors.push(`event[${index}]: stream seq must increase by 1`);
      }
    }

    if (!isPlainObject(event.integrity)) {
      errors.push(`event[${index}]: integrity is required for append-only audit streams`);
    } else {
      if (event.integrity.prevHash !== expectedPrevHash) {
        errors.push(`event[${index}]: prevHash mismatch`);
      }
      const expectedHash = hashEvent(event, event.integrity.prevHash);
      if (event.integrity.contentHash !== expectedHash) {
        errors.push(`event[${index}]: contentHash mismatch`);
      }
      expectedPrevHash = event.integrity.contentHash;
    }

    previous = event;
  }

  return { ok: errors.length === 0, errors };
}

function fixtureData(type) {
  const base = {
    decisionId: "decision:deploy-checkout-prod",
    requestId: "request:deploy-checkout-prod",
    subjectRef: "agent:tenant-a/deployer",
    action: "hobo:deployment:apply",
    resourceRef: "deployment:checkout-prod",
    reason: "policy pack hobo.guardrails@2026.06 allowed deployment",
    packVersion: "hobo.guardrails@2026.06",
    packDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    policyIds: ["policy:deployment-guardrails"],
    obligations: [],
    violations: [],
  };

  switch (type) {
    case "policy.Decided":
      return {
        ...base,
        effect: "allow",
      };
    case "policy.ViolationDetected":
      return {
        ...base,
        effect: "deny",
        violationId: "violation:breakglass-required",
        reason: "breakglass waiver required for privileged deployment",
        violations: ["breakglass waiver required"],
      };
    case "policy.WaiverRequested":
      return {
        ...base,
        waiverId: "waiver:deploy-checkout-prod",
        requestedBy: "user:platform-admin",
        reason: "requesting emergency deployment waiver",
      };
    case "policy.WaiverApproved":
      return {
        ...base,
        waiverId: "waiver:deploy-checkout-prod",
        approvedBy: "user:security-admin",
        expiresAt: "2026-06-26T14:00:00.000Z",
      };
    case "policy.ObligationCreated":
      return {
        ...base,
        obligationId: "obl-record-waiver-review",
        kind: "waiver.review",
        status: "created",
      };
    case "policy.ObligationSatisfied":
      return {
        ...base,
        obligationId: "obl-record-waiver-review",
        kind: "waiver.review",
        status: "satisfied",
      };
    case "policy.ObligationEscalated":
      return {
        ...base,
        obligationId: "obl-record-waiver-review",
        kind: "waiver.review",
        status: "escalated",
        reason: "waiver review deadline missed",
      };
    default:
      throw new Error(`unsupported policy audit fixture type: ${type}`);
  }
}

function validateData(type, data, errors) {
  if (!isPlainObject(data)) {
    errors.push("data must be an object");
    return;
  }

  for (const field of REQUIRED_POLICY_AUDIT_DATA_FIELDS[type] ?? []) {
    if (data[field] === undefined || data[field] === null || data[field] === "") {
      errors.push(`data.${field} is required`);
    }
  }
  validateStringArray(data.policyIds, "data.policyIds", errors);
  if (data.packDigest !== undefined && !SHA256_RE.test(data.packDigest)) {
    errors.push("data.packDigest must be a sha256 digest");
  }
  if (type === "policy.Decided" && !EFFECTS.has(data.effect)) {
    errors.push("data.effect must be a known policy effect");
  }
  if (data.obligations !== undefined && !Array.isArray(data.obligations)) {
    errors.push("data.obligations must be an array");
  }
  if (data.violations !== undefined && !Array.isArray(data.violations)) {
    errors.push("data.violations must be an array");
  }
  validateProtectedSubject(data.protectedSubject, errors);
  for (const path of findPlaintextPiiPaths(data, "data")) {
    errors.push(`${path} is forbidden plaintext PII`);
  }
}

function validateProtectedSubject(protectedSubject, errors) {
  if (protectedSubject === undefined || protectedSubject === null) {
    return;
  }
  if (!isPlainObject(protectedSubject)) {
    errors.push("data.protectedSubject must be an object");
    return;
  }
  requireString(protectedSubject.ciphertextRef, "data.protectedSubject.ciphertextRef", errors);
  requireString(protectedSubject.keyRef, "data.protectedSubject.keyRef", errors);
  requireString(protectedSubject.algorithm, "data.protectedSubject.algorithm", errors);
}

function findPlaintextPiiPaths(value, path) {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findPlaintextPiiPaths(entry, `${path}[${index}]`));
  }
  if (!isPlainObject(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, nested]) => {
    if (key === "protectedSubject") {
      return [];
    }
    const nextPath = `${path}.${key}`;
    const direct =
      FORBIDDEN_PII_KEYS.has(key) && isJsonString(nested) && nested.length > 0
        ? [nextPath]
        : [];
    return [...direct, ...findPlaintextPiiPaths(nested, nextPath)];
  });
}

function renderProtectedSubject(protectedSubject, destroyedKeyRefs) {
  if (!protectedSubject) {
    return null;
  }
  if (destroyedKeyRefs.includes(protectedSubject.keyRef)) {
    return {
      status: "crypto-shredded",
      key_ref_hash: sha256Hex(protectedSubject.keyRef),
    };
  }
  return {
    status: "crypto-shred-keyed-ciphertext",
    ciphertext_ref: protectedSubject.ciphertextRef,
    key_ref_hash: sha256Hex(protectedSubject.keyRef),
    algorithm: protectedSubject.algorithm,
  };
}

function validateRetention(retention, errors) {
  if (!isPlainObject(retention)) {
    errors.push("retention is required");
    return;
  }
  if (retention.class !== POLICY_AUDIT_RETENTION.class) {
    errors.push("retention.class must be security-audit");
  }
  if (retention.neverCompact !== true) {
    errors.push("retention.neverCompact must be true");
  }
  if (retention.streamPolicy !== POLICY_AUDIT_RETENTION.streamPolicy) {
    errors.push("retention.streamPolicy must be retain-org-policy-audit-stream");
  }
}

function validatePrincipal(principal, path, errors) {
  if (!isPlainObject(principal)) {
    errors.push(`${path} must be a principal object`);
    return;
  }
  requireString(principal.kind, `${path}.kind`, errors);
  requireString(principal.id, `${path}.id`, errors);
}

function validateStringArray(value, path, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must be a non-empty array`);
    return;
  }
  value.forEach((entry, index) => requireString(entry, `${path}[${index}]`, errors));
}

function requireString(value, path, errors) {
  if (!isJsonString(value) || value.length === 0) {
    errors.push(`${path} is required`);
  }
}

function requireIso(value, path, errors) {
  requireString(value, path, errors);
  if (isJsonString(value) && Number.isNaN(Date.parse(value))) {
    errors.push(`${path} must be ISO-8601`);
  }
}

function obligationIds(data) {
  if (data.obligationId) {
    return [data.obligationId];
  }
  return (data.obligations ?? []).map((obligation) => obligation.id).filter(Boolean);
}

function statusForEvent(event) {
  if (event.type === "policy.Decided") {
    return event.data.effect === "deny" ? "Denied" : "Allowed";
  }
  if (event.type === "policy.ViolationDetected") {
    return "Denied";
  }
  return "Success";
}

function messageForEvent(event) {
  if (event.data.reason) {
    return event.data.reason;
  }
  if (event.data.obligationId) {
    return `${event.data.obligationId} ${event.data.status}`;
  }
  return event.type;
}

function hashEvent(event, previousHash) {
  return sha256Digest({
    event: stripIntegrity(event),
    prevHash: previousHash,
  });
}

function stripIntegrity(event) {
  const stripped = clone(event);
  delete stripped.integrity;
  return stripped;
}

function sha256Digest(value) {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value, path = "$") {
  if (value === null || isJsonString(value) || isJsonBoolean(value)) {
    return value;
  }
  if (isJsonNumber(value)) {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must be finite`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalJsonValue(entry, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          if (value[key] === undefined) {
            throw new TypeError(`${path}.${key} must not be undefined`);
          }
          return [key, canonicalJsonValue(value[key], `${path}.${key}`)];
        }),
    );
  }
  throw new TypeError(`${path} must be JSON`);
}

function slug(value) {
  return String(value).toLowerCase().replaceAll(".", "-");
}

function isPlainObject(value) {
  return (
    value !== null &&
    isJsonObject(value) &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
