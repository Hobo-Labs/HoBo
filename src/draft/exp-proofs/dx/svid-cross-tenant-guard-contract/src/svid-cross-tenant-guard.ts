import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../../../technical-proofs/identity-event-contract/src/identity-event-contract.js";
import {
  createJwtSvidIssuer,
} from "../../../../technical-proofs/jwt-svid-issuance-contract/src/jwt-svid-issuer.js";
import {
  verifyWorkloadAttestation,
} from "../../../../technical-proofs/workload-attestation-intake-contract/src/workload-attestation.js";
import { isJsonString, isJsonObject } from "./json.js";


const DEFAULT_TTL_SECONDS = 5 * 60;
const DEFAULT_DENIAL_TARGET = { kind: "provider", id: "credential-broker" };
const IDENTITY_ACTOR = { kind: "service", id: "yard/identity" };

export async function evaluateSvidCrossTenantGuard(input) {
  const request = normalizeRequest(input);
  const attestation = verifyWorkloadAttestation(request.document, {
    knownImageDigests: request.knownImageDigests,
    hostPublicKeys: request.hostPublicKeys,
    now: request.now,
    requestedIsolationTier: request.requestedIsolationTier,
  });
  const isolationDecision = isolationFromAttestation(attestation);

  if (attestation.state !== "attested") {
    const denied = createTokenDeniedEvent({
      request,
      reason: `workload-not-attested: ${attestation.reason}`,
    });
    return {
      ok: false,
      requestId: request.requestId,
      attestation,
      isolationDecision,
      deniedEvents: [denied],
      anomalies: [],
    };
  }

  const service = createJwtSvidIssuer({
    issuer: request.issuer,
    now: () => new Date(request.now),
    ttlSeconds: request.ttlSeconds,
    idFactory: request.idFactory,
  });
  const issued = await service.issue({
    requestId: request.requestId,
    agentName: request.agentName,
    audience: request.audience,
    attestationVerdict: attestation,
    requestedScope: request.requestedScope,
    inferredGrant: request.inferredGrant,
  });
  const anomalies = detectAnomalies({ request, attestation, issued });

  if (!issued.ok) {
    const denied = createTokenDeniedEvent({
      request,
      reason: issued.reason,
    });
    return {
      ok: false,
      requestId: request.requestId,
      attestation,
      isolationDecision,
      deniedEvents: [denied],
      anomalies,
      issued,
    };
  }

  return {
    ok: true,
    requestId: request.requestId,
    attestation,
    isolationDecision,
    tokenTenant: issued.claims.tenant,
    issued,
    deniedEvents: [],
    anomalies,
  };
}

function normalizeRequest(input) {
  if (!isPlainObject(input)) {
    throw new Error("SVID cross-tenant guard request must be an object");
  }
  const now = requireString(input.now, "now");
  if (Number.isNaN(Date.parse(now))) {
    throw new Error("now must be ISO-8601");
  }
  if (!input.issuer || !(input.issuer.signJwtSvid instanceof Function)) {
    throw new Error("issuer must support signJwtSvid()");
  }

  return {
    requestId: requireString(input.requestId, "requestId"),
    agentName: requireString(input.agentName, "agentName"),
    audience: input.audience ?? "hobo-provider",
    document: input.document,
    hostPublicKeys: Array.isArray(input.hostPublicKeys) ? input.hostPublicKeys : [],
    knownImageDigests: Array.isArray(input.knownImageDigests) ? input.knownImageDigests : [],
    now,
    issuer: input.issuer,
    requestedTenant: input.requestedTenant,
    requestedParentPrincipal: input.requestedParentPrincipal,
    requestedCodeVersion: input.requestedCodeVersion,
    requestedIsolationTier: input.requestedIsolationTier,
    requestedScope: input.requestedScope,
    inferredGrant: input.inferredGrant,
    ttlSeconds: input.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    idFactory: input.idFactory ?? deterministicIds("svid"),
  };
}

function isolationFromAttestation(attestation) {
  if (attestation.state === "attested") {
    return {
      allowedTier: attestation.policy.isolationFloor,
      requestedTierAccepted: true,
      nonOverridable: attestation.policy.nonOverridable,
    };
  }
  return {
    allowedTier: attestation.policy.isolationFloor,
    requestedTierAccepted: false,
    nonOverridable: attestation.policy.nonOverridable,
  };
}

function detectAnomalies({ request, attestation, issued }) {
  const anomalies = [];
  if (hasSelfAssertedClaimConflict(request, attestation)) {
    anomalies.push({
      code: "self-asserted-claims-overridden",
      measured: {
        tenant: attestation.binding.tenant,
        parentPrincipal: clone(attestation.binding.parentPrincipal),
        codeVersion: clone(attestation.binding.codeVersion),
      },
      requested: {
        tenant: request.requestedTenant,
        parentPrincipal: clone(request.requestedParentPrincipal),
        codeVersion: clone(request.requestedCodeVersion),
      },
    });
  }
  if (issued.ok && canonicalJson(request.requestedScope) !== canonicalJson(issued.scope)) {
    anomalies.push({
      code: "requested-scope-clamped",
      requestedScope: clone(request.requestedScope),
      issuedScope: clone(issued.scope),
    });
  }
  return anomalies;
}

function hasSelfAssertedClaimConflict(request, attestation) {
  if (attestation.claimConflict) {
    return true;
  }
  if (request.requestedTenant !== undefined && request.requestedTenant !== attestation.binding.tenant) {
    return true;
  }
  if (
    request.requestedParentPrincipal !== undefined &&
    canonicalJson(request.requestedParentPrincipal) !== canonicalJson(attestation.binding.parentPrincipal)
  ) {
    return true;
  }
  if (
    request.requestedCodeVersion !== undefined &&
    canonicalJson(request.requestedCodeVersion) !== canonicalJson(attestation.binding.codeVersion)
  ) {
    return true;
  }
  return false;
}

function createTokenDeniedEvent({ request, reason }) {
  const event = createIdentityEvent(
    "token.Denied",
    {
      requestId: request.requestId,
      subject: { kind: "agent", id: `agent:${request.agentName}` },
      target: request.audience
        ? { kind: "provider", id: String(request.audience) }
        : DEFAULT_DENIAL_TARGET,
      reason,
    },
    {
      id: `evt-${request.requestId}-denied`,
      actor: IDENTITY_ACTOR,
      time: request.now,
      seq: 1,
      correlationId: request.requestId,
      causationId: request.requestId,
    },
  );
  const validation = validateIdentityEvent(event);
  if (!validation.ok) {
    throw new Error(`invalid token.Denied event: ${validation.errors.join("; ")}`);
  }
  return event;
}

function requireString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function deterministicIds(prefix) {
  let next = 1;
  return () => `${prefix}-${next++}`;
}

function canonicalJson(value) {
  return JSON.stringify(sortForCanonicalJson(value));
}

function sortForCanonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortForCanonicalJson(value[key])]),
  );
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
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}
