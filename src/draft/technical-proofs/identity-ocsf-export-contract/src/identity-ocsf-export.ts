import { createHash } from "node:crypto";

import {
  foldCredentialAudit,
  IDENTITY_EVENT_TYPES,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import {
  exportPolicyEventToOcsf,
  validatePolicyAuditEvent,
} from "../../../exp-proofs/api/policy-audit-export-contract/src/policy-audit-export.js";
import { isJsonString, isJsonObject } from "./json.js";


export const IDENTITY_OCSF_EXPORT_VERSION = "hobo.identity-ocsf-export/v1";

const IDENTITY_EVENT_TYPE_SET = new Set(IDENTITY_EVENT_TYPES);

const OCSF_MAPPING = deepFreeze({
  "identity.Issued": mapping("Account Change", 3001, 1, "Identity Issued"),
  "identity.Rotated": mapping("Account Change", 3001, 2, "Identity Rotated"),
  "token.Granted": mapping("Authorization", 3004, 1, "Token Granted"),
  "token.Used": mapping("Authorization", 3004, 2, "Token Used"),
  "token.Denied": mapping("Authorization", 3004, 3, "Token Denied"),
  "token.Revoked": mapping("Authorization", 3004, 4, "Token Revoked"),
  "user.Authenticated": mapping("Authentication", 3002, 1, "User Authenticated"),
  "session.Started": mapping("Authentication", 3002, 2, "Session Started"),
  "session.Refreshed": mapping("Authentication", 3002, 3, "Session Refreshed"),
  "session.Revoked": mapping("Authentication", 3002, 4, "Session Revoked"),
  "secret.Accessed": mapping("Authorization", 3004, 5, "Secret Accessed"),
  "config.Resolved": mapping("Authorization", 3004, 6, "Config Resolved"),
});

export function exportIdentityEventToOcsf(event, options = {}) {
  const validation = validateIdentityEvent(event);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }

  const coverage = validateIdentityOcsfMappingCoverage([event.type]);
  if (!coverage.ok) {
    throw new Error(coverage.errors.join("; "));
  }

  return deepFreeze(renderIdentityEvent(event, options));
}

export function exportIdentityAuditToOcsf(events, options = {}) {
  if (!Array.isArray(events)) {
    throw new Error("events must be an array");
  }

  const ordering = orderingFor(events);
  return deepFreeze(
    events.map((event, index) => {
      const exported = renderIdentityEventAfterValidation(event, options);
      exported.hobo.ordering =
        ordering.mode === "preserved"
          ? {
              mode: "preserved",
              index,
              previous_event_id: index === 0 ? null : events[index - 1].id,
            }
          : {
              mode: "unordered",
              index,
              reason: ordering.reason,
            };
      return exported;
    }),
  );
}

export function exportCredentialAuditChainToOcsf(events, options = {}) {
  const exported = exportIdentityAuditToOcsf(events, options).map(clone);
  const audit = foldCredentialAudit(events);
  const chainByGrant = new Map(audit.chains.map((chain) => [chain.grants[0], chain]));
  const grantByUsage = new Map();

  for (const chain of audit.chains) {
    for (const usageId of chain.uses) {
      grantByUsage.set(usageId, chain.grants[0]);
    }
  }

  return deepFreeze(
    exported.map((record, index) => {
      const grantId = grantIdFor(events[index], grantByUsage);
      const chain = grantId ? chainByGrant.get(grantId) : undefined;
      if (chain) {
        record.hobo.credential_chain = {
          id: `chain:${grantId}`,
          user: chain.user ?? null,
          agent: chain.agent ?? null,
          target: chain.target,
          audience: chain.audience,
          scopes: [...chain.scopes],
          grants: [...chain.grants],
          uses: [...chain.uses],
          secret_refs: [...chain.secretRefs],
          revoked: chain.revoked,
        };
      }
      return record;
    }),
  );
}

export function exportSecurityAuditEventToOcsf(event, options = {}) {
  if (IDENTITY_EVENT_TYPE_SET.has(event?.type)) {
    return exportIdentityEventToOcsf(event, options);
  }

  if (event?.type === "policy.Decided") {
    const validation = validatePolicyAuditEvent(event);
    if (!validation.ok) {
      throw new Error(validation.errors.join("; "));
    }
    const policyRecord = clone(exportPolicyEventToOcsf(event, options));
    policyRecord.metadata.product.name = "HoBo Identity OCSF Export";
    policyRecord.hobo = {
      ...policyRecord.hobo,
      export_kind: "identity-audit",
      export_version: IDENTITY_OCSF_EXPORT_VERSION,
      projection: {
        mode: "replayable",
        source_schema: event.schemaVersion,
      },
    };
    return deepFreeze(policyRecord);
  }

  throw new Error(`missing OCSF mapping for ${String(event?.type)}`);
}

export function validateIdentityOcsfMappingCoverage(eventTypes = IDENTITY_EVENT_TYPES) {
  const missing = eventTypes.filter((type) => !OCSF_MAPPING[type]);
  return deepFreeze({
    ok: missing.length === 0,
    covered: eventTypes.filter((type) => OCSF_MAPPING[type]),
    missing,
    errors: missing.map((type) => `missing OCSF mapping for ${type}`),
  });
}

function renderIdentityEventAfterValidation(event, options) {
  const validation = validateIdentityEvent(event);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }
  return renderIdentityEvent(event, options);
}

function renderIdentityEvent(event, options) {
  const ocsf = OCSF_MAPPING[event.type];
  if (!ocsf) {
    throw new Error(`missing OCSF mapping for ${event.type}`);
  }

  const hobo = {
    export_kind: "identity-audit",
    export_version: IDENTITY_OCSF_EXPORT_VERSION,
    event_id: event.id,
    event_type: event.type,
    tenant: event.tenant,
    seq: event.seq,
    correlation_id: event.correlationId,
    causation_id: event.causationId,
    retention: {
      class: event.retention.class,
      never_compact: event.retention.neverCompact,
      stream_policy: event.retention.streamPolicy ?? null,
    },
    projection: {
      mode: "replayable",
      source_schema: event.schemaVersion,
    },
    subject: subjectFor(event),
    target: targetFor(event),
    identity: identityFor(event),
    token: tokenFor(event),
    session: sessionFor(event),
  };

  const protectedSubject = renderProtectedSubject(event.data.protectedSubject, options.destroyedKeyRefs ?? []);
  if (protectedSubject) {
    hobo.protected_subject = protectedSubject;
  }

  return {
    schema_version: "ocsf-1.x",
    time: Date.parse(event.time),
    severity_id: severityFor(event),
    status: statusFor(event),
    message: messageFor(event),
    metadata: {
      version: "1.0.0",
      product: {
        name: "HoBo Identity OCSF Export",
        vendor_name: "HoBo",
      },
    },
    category_uid: ocsf.category_uid,
    category_name: ocsf.category_name,
    class_uid: ocsf.class_uid,
    class_name: ocsf.class_name,
    activity_id: ocsf.activity_id,
    activity_name: ocsf.activity_name,
    type_uid: ocsf.class_uid * 100 + ocsf.activity_id,
    actor: renderPrincipal(event.actor),
    api: {
      operation: operationFor(event),
    },
    resources: resourcesFor(event),
    hobo,
  };
}

function mapping(className, classUid, activityId, activityName) {
  return {
    category_uid: 3,
    category_name: "Identity & Access Management",
    class_uid: classUid,
    class_name: className,
    activity_id: activityId,
    activity_name: activityName,
  };
}

function orderingFor(events) {
  let previous = null;
  for (const event of events) {
    if (previous && event.seq <= previous.seq) {
      return { mode: "unordered", reason: "non-monotonic-seq" };
    }
    if (previous && event.tenant !== previous.tenant) {
      return { mode: "unordered", reason: "mixed-tenant-stream" };
    }
    previous = event;
  }
  return { mode: "preserved" };
}

function grantIdFor(event, grantByUsage) {
  if (event.type === "token.Granted" || event.type === "token.Used" || event.type === "token.Revoked") {
    return event.data.grantId;
  }
  if (event.type === "secret.Accessed") {
    return grantByUsage.get(event.data.tokenUsageId);
  }
  return null;
}

function renderProtectedSubject(protectedSubject, destroyedKeyRefs) {
  if (protectedSubject === undefined || protectedSubject === null) {
    return null;
  }
  if (!isPlainObject(protectedSubject)) {
    throw new Error("data.protectedSubject must be an object");
  }
  requireString(protectedSubject.ciphertextRef, "data.protectedSubject.ciphertextRef");
  requireString(protectedSubject.keyRef, "data.protectedSubject.keyRef");
  requireString(protectedSubject.algorithm, "data.protectedSubject.algorithm");

  if (destroyedKeyRefs.includes(protectedSubject.keyRef)) {
    return {
      status: "crypto-shredded",
      key_ref_hash: sha256Digest(protectedSubject.keyRef),
    };
  }
  return {
    status: "crypto-shred-keyed-ciphertext",
    ciphertext_ref: protectedSubject.ciphertextRef,
    key_ref_hash: sha256Digest(protectedSubject.keyRef),
    algorithm: protectedSubject.algorithm,
  };
}

function renderPrincipal(principal) {
  const rendered = {
    type: principal.kind,
    uid: principal.id,
  };
  if (principal.delegatedBy) {
    rendered.delegated_by = renderPrincipal(principal.delegatedBy);
  }
  return rendered;
}

function subjectFor(event) {
  if (event.data.subject) {
    return renderPrincipal(event.data.subject);
  }
  if (event.data.principal) {
    return renderPrincipal(event.data.principal);
  }
  return null;
}

function targetFor(event) {
  if (!event.data.target) {
    return null;
  }
  return {
    type: event.data.target.kind,
    uid: event.data.target.id,
  };
}

function identityFor(event) {
  if (!event.type.startsWith("identity.")) {
    return null;
  }
  return stripNulls({
    id: event.data.identityId,
    previous_id: event.data.previousIdentityId ?? null,
    svid_ref: event.data.svidRef,
    expires_at: event.data.expiresAt,
    scopes: event.data.scope ?? [],
  });
}

function tokenFor(event) {
  if (!event.type.startsWith("token.") && event.type !== "secret.Accessed") {
    return null;
  }
  return stripNulls({
    grant_id: event.data.grantId ?? null,
    usage_id: event.data.usageId ?? event.data.tokenUsageId ?? null,
    request_id: event.data.requestId ?? null,
    audience: event.data.audience ?? null,
    scopes: event.data.scopes ?? null,
    token_ref: event.data.tokenRef ?? null,
    expires_at: event.data.expiresAt ?? null,
    reason: event.data.reason ?? null,
  });
}

function sessionFor(event) {
  if (!event.type.startsWith("session.") && event.type !== "user.Authenticated") {
    return null;
  }
  return stripNulls({
    id: event.data.sessionId,
    previous_id: event.data.previousSessionId ?? null,
    provider: event.data.provider ?? null,
    auth_time: event.data.authTime ?? null,
    expires_at: event.data.expiresAt ?? null,
    reason: event.data.reason ?? null,
  });
}

function resourcesFor(event) {
  const refs = [];
  if (event.data.resource) {
    refs.push({ uid: event.data.resource });
  }
  if (event.data.secretRef) {
    refs.push({ uid: event.data.secretRef, type: "secret" });
  }
  if (event.data.configRef) {
    refs.push({ uid: event.data.configRef, type: "config" });
  }
  if (event.data.audience) {
    refs.push({ uid: event.data.audience, type: "audience" });
  }
  return refs;
}

function operationFor(event) {
  return event.data.operation ?? event.data.provider ?? event.type;
}

function statusFor(event) {
  if (event.type === "token.Denied") {
    return "Denied";
  }
  if (event.type === "token.Revoked" || event.type === "session.Revoked") {
    return "Revoked";
  }
  return "Success";
}

function severityFor(event) {
  return event.type === "token.Denied" ? 3 : 1;
}

function messageFor(event) {
  if (event.data.reason) {
    return event.data.reason;
  }
  if (event.data.operation) {
    return event.data.operation;
  }
  return event.type;
}

function stripNulls(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

function requireString(value, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${path} is required`);
  }
}

function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
