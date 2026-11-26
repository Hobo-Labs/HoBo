import { isJsonObject } from "./json.js";
import {
  createHash,
  sign,
  verify,
} from "node:crypto";

const BREAK_GLASS_VERSION = "hobo.breakglass/v1";

export function createYardGovernanceLedger({
  yardId,
  offlinePublicKeys = {},
} = {}) {
  if (!yardId) {
    throw new Error("yardId is required");
  }

  const orgAdmins = new Set();
  const roleBindings = [];
  const usedBreakGlassNonces = new Set();

  return {
    yardId,
    events: [],
    offlinePublicKeys,
    usedBreakGlassNonces,
    currentOrgAdmins() {
      return [...orgAdmins];
    },
    roleBindings() {
      return roleBindings.map((binding) => ({ ...binding }));
    },
    hasOrgAdmin(principalId) {
      return orgAdmins.has(principalId);
    },
    addRoleBinding(principalId, role, source) {
      roleBindings.push({ principalId, role, source });
      if (role === "Org-Admin") {
        orgAdmins.add(principalId);
      }
    },
    grantOrgAdmin(principalId) {
      orgAdmins.add(principalId);
    },
    revokeOrgAdmin(principalId) {
      orgAdmins.delete(principalId);
    },
  };
}

export function seedGenesisAdmin(ledger, {
  principalId,
  actorId,
  requestId,
  evidence = {},
}) {
  if (ledger.events.some((event) => event.type === "identity.GenesisAdmin")) {
    return failure("GENESIS_ALREADY_CONSUMED");
  }

  ledger.grantOrgAdmin(principalId);

  const events = [
    appendEvent(ledger, {
      type: "identity.GenesisAdmin",
      actor: actorId,
      requestId,
      data: {
        principalId,
        role: "Org-Admin",
        oneTime: true,
        evidence,
      },
    }),
    appendEvent(ledger, {
      type: "role.BindingCreated",
      actor: actorId,
      requestId,
      data: {
        principalId,
        role: "Org-Admin",
        source: "genesis",
      },
    }),
  ];

  return success({ events });
}

export function bindFirstRealRole(ledger, {
  actorId,
  targetPrincipalId,
  role,
  requestId,
}) {
  const activeGenesisAdmin = activeGenesisAdminPrincipal(ledger);
  if (!activeGenesisAdmin || actorId !== activeGenesisAdmin || !ledger.hasOrgAdmin(actorId)) {
    const denied = appendEvent(ledger, {
      type: "policy.Decided",
      actor: actorId,
      requestId,
      data: {
        decision: {
          effect: "deny",
          reason: "first role binding requires the active genesis Org-Admin",
        },
        action: "hobo:role:bind",
        targetPrincipalId,
        role,
      },
    });

    return failure("GENESIS_ADMIN_REQUIRED", { events: [denied] });
  }

  ledger.addRoleBinding(targetPrincipalId, role, "genesis-first-role");

  const events = [
    appendEvent(ledger, {
      type: "role.BindingCreated",
      actor: actorId,
      requestId,
      data: {
        principalId: targetPrincipalId,
        role,
        source: "genesis-first-role",
        bootstrapAuthority: "identity.GenesisAdmin",
      },
    }),
  ];

  return success({ events });
}

export function rotateGenesisAdmin(ledger, {
  fromPrincipalId,
  toPrincipalId,
  actorId,
  requestId,
}) {
  if (!ledger.hasOrgAdmin(fromPrincipalId)) {
    return failure("GENESIS_ADMIN_NOT_CURRENT");
  }

  ledger.revokeOrgAdmin(fromPrincipalId);
  ledger.addRoleBinding(toPrincipalId, "Org-Admin", "genesis-rotation");

  const events = [
    appendEvent(ledger, {
      type: "identity.GenesisAdminRotated",
      actor: actorId,
      requestId,
      data: {
        from: fromPrincipalId,
        to: toPrincipalId,
      },
    }),
    appendEvent(ledger, {
      type: "role.BindingRevoked",
      actor: actorId,
      requestId,
      data: {
        principalId: fromPrincipalId,
        role: "Org-Admin",
        source: "genesis-rotation",
      },
    }),
    appendEvent(ledger, {
      type: "role.BindingCreated",
      actor: actorId,
      requestId,
      data: {
        principalId: toPrincipalId,
        role: "Org-Admin",
        source: "genesis-rotation",
      },
    }),
  ];

  return success({ events });
}

export function diagnoseGenesisAdmin(ledger) {
  const principalId = activeGenesisAdminPrincipal(ledger);
  if (!principalId) {
    return [];
  }

  return [
    {
      code: "GENESIS_ADMIN_NOT_ROTATED",
      severity: "warning",
      principalId,
      message: "Genesis Org-Admin remains active; rotate it to a durable admin binding.",
    },
  ];
}

export function createOfflineBreakGlassCredential({
  keyId,
  privateKey,
  subjectId,
  action,
  resourceId,
  reason,
  nonce,
  issuedAt = "1970-01-01T00:00:00.000Z",
}) {
  const unsigned = breakGlassPayload({
    keyId,
    subjectId,
    action,
    resourceId,
    reason,
    nonce,
    issuedAt,
  });
  const payload = canonicalize(unsigned);
  const signature = sign(null, Buffer.from(payload), privateKey).toString("base64");

  return {
    ...unsigned,
    payloadHash: sha256(payload),
    signature,
  };
}

export function recoverWithBreakGlass(ledger, {
  credential,
  idpAvailable,
  mandatoryPolicyBlocksAllChanges,
  requestId,
}) {
  if (!credential || credential.idpPath !== false) {
    return deniedDecision(ledger, {
      requestId,
      actor: credential?.subjectId ?? "unknown",
      code: "OFFLINE_SIGNATURE_REQUIRED",
      reason: "offline break-glass signature required",
      data: {
        idpAvailable,
        mandatoryPolicyBlocksAllChanges,
      },
    });
  }

  const publicKey = ledger.offlinePublicKeys[credential.keyId];
  if (!publicKey || !hasValidOfflineSignature(credential, publicKey)) {
    return deniedDecision(ledger, {
      requestId,
      actor: credential.subjectId,
      code: "INVALID_BREAK_GLASS_SIGNATURE",
      reason: "offline break-glass signature invalid",
      data: {
        keyId: credential.keyId,
      },
    });
  }

  if (ledger.usedBreakGlassNonces.has(credential.nonce)) {
    return deniedDecision(ledger, {
      requestId,
      actor: credential.subjectId,
      code: "BREAK_GLASS_REPLAY",
      reason: "break-glass credential nonce already used",
      data: {
        nonce: credential.nonce,
      },
    });
  }

  if (!isEmergencyRecoveryContext({
    idpAvailable,
    mandatoryPolicyBlocksAllChanges,
  })) {
    return deniedDecision(ledger, {
      requestId,
      actor: credential.subjectId,
      code: "BREAK_GLASS_CONTEXT_NOT_BRICKED",
      reason: "break-glass requires IdP outage and a bricking mandatory policy rule",
      data: {
        idpAvailable,
        mandatoryPolicyBlocksAllChanges,
        offlineSigned: true,
        idpPath: false,
      },
    });
  }

  ledger.usedBreakGlassNonces.add(credential.nonce);

  const decision = {
    effect: "allow",
    reason: "offline break-glass authorized recovery",
  };

  const events = [
    appendEvent(ledger, {
      type: "policy.Decided",
      actor: credential.subjectId,
      requestId,
      data: {
        decision,
        action: credential.action,
        resourceId: credential.resourceId,
        idpAvailable,
        mandatoryPolicyBlocksAllChanges,
      },
    }),
    appendEvent(ledger, {
      type: "identity.BreakGlassUsed",
      actor: credential.subjectId,
      requestId,
      data: {
        subjectId: credential.subjectId,
        action: credential.action,
        resourceId: credential.resourceId,
        reason: credential.reason,
        nonce: credential.nonce,
        offlineSigned: true,
        idpPath: false,
        signatureFingerprint: fingerprint(credential.signature),
      },
    }),
  ];

  return success({ decision, events });
}

export function selfGrantOrgAdmin(ledger, {
  actorId,
  targetPrincipalId,
  requestId,
}) {
  const denied = appendEvent(ledger, {
    type: "policy.Decided",
    actor: actorId,
    requestId,
    data: {
      decision: {
        effect: "deny",
        reason: "Org-Admin cannot be self-granted",
      },
      action: "hobo:role:bind",
      targetPrincipalId,
      role: "Org-Admin",
    },
  });

  return failure("SELF_GRANT_BLOCKED", { events: [denied] });
}

function activeGenesisAdminPrincipal(ledger) {
  const genesis = ledger.events.find((event) => event.type === "identity.GenesisAdmin");
  if (!genesis) {
    return undefined;
  }
  const rotated = ledger.events.some((event) => event.type === "identity.GenesisAdminRotated");
  return rotated ? undefined : genesis.data.principalId;
}

function deniedDecision(ledger, {
  requestId,
  actor,
  code,
  reason,
  data = {},
}) {
  const decision = {
    effect: "deny",
    reason,
  };
  const event = appendEvent(ledger, {
    type: "policy.Decided",
    actor,
    requestId,
    data: {
      decision,
      ...data,
    },
  });

  return failure(code, { decision, events: [event] });
}

function hasValidOfflineSignature(credential, publicKey) {
  const unsigned = breakGlassPayload(credential);
  const payload = canonicalize(unsigned);

  if (credential.version !== BREAK_GLASS_VERSION) {
    return false;
  }

  if (credential.payloadHash !== sha256(payload)) {
    return false;
  }

  try {
    return verify(
      null,
      Buffer.from(payload),
      publicKey,
      Buffer.from(credential.signature, "base64"),
    );
  } catch {
    return false;
  }
}

function isEmergencyRecoveryContext({
  idpAvailable,
  mandatoryPolicyBlocksAllChanges,
}) {
  return idpAvailable === false && mandatoryPolicyBlocksAllChanges === true;
}

function breakGlassPayload({
  keyId,
  subjectId,
  action,
  resourceId,
  reason,
  nonce,
  issuedAt,
}) {
  return {
    version: BREAK_GLASS_VERSION,
    keyId,
    subjectId,
    action,
    resourceId,
    reason,
    nonce,
    issuedAt,
    idpPath: false,
  };
}

function appendEvent(ledger, {
  type,
  actor,
  requestId,
  data,
}) {
  const event = {
    id: `${ledger.yardId}:event:${ledger.events.length + 1}`,
    yardId: ledger.yardId,
    type,
    actor,
    requestId,
    data,
  };

  ledger.events.push({
    ...event,
    auditHash: sha256(canonicalize(event)),
  });

  return ledger.events.at(-1);
}

function success(fields = {}) {
  return {
    ok: true,
    ...fields,
  };
}

function failure(code, fields = {}) {
  return {
    ok: false,
    code,
    ...fields,
  };
}

function fingerprint(signature) {
  return `sha256:${createHash("sha256").update(signature, "base64").digest("hex")}`;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }

  if (value && isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
