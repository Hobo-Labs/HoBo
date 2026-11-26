import {
  parseJwtSvidCompact,
} from "../../hobo-jwt-svid-contract/src/jwt-svid.js";
import {
  createFixtureIdJag,
  parseJwtBearerGrantRequest,
} from "../../id-jag-token-exchange-contract/src/id-jag-token-exchange.js";
import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const DEFAULT_ISSUER = "https://identity.hobo.test";
const DEFAULT_NOW = "2026-06-28T12:00:00.000Z";
const DEFAULT_SUBJECT = {
  kind: "agent",
  id: "agent:triage",
  delegatedBy: { kind: "user", id: "user:priya" },
};
const DEFAULT_SVID_AUDIENCE = "yard-token-broker";
const DEFAULT_ASANA = {
  id: "asana",
  audience: "https://authorization.asana.test",
  resource: "https://api.asana.test/tasks",
  allowedScopes: ["tasks:read", "tasks:write"],
};
const DEFAULT_HOBO_APP = {
  id: "orders",
  audience: "hobo-app://orders",
  resource: "urn:hobo:app:orders",
  allowedScopes: ["orders:read"],
};

export const REPLAY_REJECTION_REASONS = Object.freeze({
  "jwt-svid-expired": "JWT-SVID replay rejected: credential expired or outside rotation window",
  "jwt-svid-audience-mismatch": "JWT-SVID replay rejected: audience mismatch",
  "kid-retired-after-rollover": "credential replay rejected: signing kid retired after rollover",
  "id-jag-expired": "ID-JAG replay rejected: assertion expired",
  "id-jag-audience-mismatch": "ID-JAG replay rejected: audience mismatch",
  "id-jag-resource-mismatch": "ID-JAG replay rejected: resource mismatch",
  "id-jag-nonce-replay": "ID-JAG replay rejected: nonce already consumed",
  "inbound-id-jag-nonce-replay": "inbound ID-JAG replay rejected: nonce already consumed",
  "provider-access-token-expired": "provider access token replay rejected: credential expired",
  "provider-access-token-audience-mismatch": "provider access token replay rejected: audience mismatch",
  "invalid-credential": "credential replay rejected: invalid credential",
});

export function createTokenReplayResistanceHarness(options = {}) {
  const now = options.now ?? (() => new Date(DEFAULT_NOW));
  const idFactory = options.idFactory ?? defaultIdFactory();
  const eventSink = options.eventSink ?? (() => {});
  const emittedEvents = [];
  const consumedOutboundNonces = options.consumedOutboundNonces ?? new Set();
  const consumedInboundNonces = options.consumedInboundNonces ?? new Set();
  const retiredKeyAcceptUntilByKid = normalizeRetiredKeys(
    options.retiredKeyAcceptUntilByKid ?? {},
  );

  function emit(events) {
    for (const event of events) {
      emittedEvents.push(event);
      eventSink(event);
    }
    return events;
  }

  function deny({ requestId, reasonCode, subject, target, at }) {
    const event = buildIdentityEvent(
      "token.Denied",
      {
        requestId,
        subject: subjectForAudit(subject),
        target: normalizeTargetForAudit(target),
        reason: reasonForCode(reasonCode),
      },
      {
        id: `evt-${requestId}-denied`,
        time: dateForAttempt(at, now).toISOString(),
        seq: 1,
        correlationId: requestId,
        causationId: requestId,
      },
    );

    return {
      ok: false,
      requestId,
      reasonCode,
      reason: event.data.reason,
      events: emit([event]),
    };
  }

  function grantAndUse({
    requestId,
    subject,
    target,
    audience,
    scopes,
    tokenRef,
    expiresAt,
    operation,
    resource,
    at,
  }) {
    const grantId = idFactory("grant");
    const usageId = idFactory("use");
    const time = dateForAttempt(at, now).toISOString();
    const granted = buildIdentityEvent(
      "token.Granted",
      {
        grantId,
        subject: subjectForAudit(subject),
        target: normalizeTargetForAudit(target),
        audience,
        scopes: normalizeScopes(scopes),
        tokenRef,
        expiresAt,
      },
      {
        id: `evt-${grantId}-granted`,
        time,
        seq: 1,
        correlationId: requestId,
        causationId: requestId,
      },
    );
    const used = buildIdentityEvent(
      "token.Used",
      {
        grantId,
        usageId,
        operation,
        resource,
      },
      {
        id: `evt-${usageId}-used`,
        time,
        seq: 2,
        correlationId: requestId,
        causationId: granted.id,
      },
    );

    return emit([granted, used]);
  }

  function useJwtSvid(input) {
    const requestId = requireString(input.requestId, "requestId");
    const target = input.target ?? { kind: "service", id: "yard/token-broker" };
    const at = dateForAttempt(input.at, now);
    let parsed;
    try {
      parsed = parseJwtSvidCompact(requireString(input.token, "token"), {
        now: Math.floor(at.getTime() / 1000),
      });
    } catch (error) {
      return deny({
        requestId,
        reasonCode: mapJwtSvidError(error),
        subject: DEFAULT_SUBJECT,
        target,
        at,
      });
    }

    const expectedAudience = requireString(input.expectedAudience, "expectedAudience");
    if (!audienceIncludes(parsed.claims.aud, expectedAudience)) {
      return deny({
        requestId,
        reasonCode: "jwt-svid-audience-mismatch",
        subject: subjectFromSvid(parsed),
        target,
        at,
      });
    }

    const kid = parsed.header.kid;
    if (!isKidAccepted(kid, at, retiredKeyAcceptUntilByKid)) {
      return deny({
        requestId,
        reasonCode: "kid-retired-after-rollover",
        subject: subjectFromSvid(parsed),
        target,
        at,
      });
    }

    const expiresAt = new Date(parsed.claims.exp * 1000).toISOString();
    const events = grantAndUse({
      requestId,
      subject: subjectFromSvid(parsed),
      target,
      audience: expectedAudience,
      scopes: scopeStringsFromSvid(parsed.claims.scope),
      tokenRef: `identity://svid/${parsed.identity.tenant}/${parsed.identity.agent}`,
      expiresAt,
      operation: input.operation ?? "jwt-svid.authorize",
      resource: input.resource ?? `spiffe://${parsed.identity.trustDomain}/${parsed.identity.tenant}/agent/${parsed.identity.agent}`,
      at,
    });

    return {
      ok: true,
      requestId,
      credentialType: "jwt-svid",
      kid,
      expiresAt,
      events,
    };
  }

  function redeemOutboundIdJag(input) {
    return redeemIdJag({
      input,
      consumedNonces: consumedOutboundNonces,
      target: input.target,
      targetKind: "external-app",
      operation: "oauth2-xaa.redeem",
      nonceReplayReasonCode: "id-jag-nonce-replay",
    });
  }

  function redeemInboundIdJag(input) {
    return redeemIdJag({
      input: {
        ...input,
        target: input.app,
      },
      consumedNonces: consumedInboundNonces,
      target: input.app,
      targetKind: "hobo-app",
      operation: "inbound-xaa.accept",
      nonceReplayReasonCode: "inbound-id-jag-nonce-replay",
    });
  }

  function redeemIdJag({
    input,
    consumedNonces,
    target,
    targetKind,
    operation,
    nonceReplayReasonCode,
  }) {
    const requestId = requireString(input.requestId, "requestId");
    const assertion = requireString(input.assertion, "assertion");
    const at = dateForAttempt(input.at, now);
    const auditSubject = subjectFromIdJagAssertion(assertion);
    const auditTarget = { kind: targetKind, id: requireString(target.id, "target.id") };

    let parsed;
    try {
      parsed = parseJwtBearerGrantRequest(
        {
          grant_type: JWT_BEARER_GRANT_TYPE,
          assertion,
        },
        {
          expectedAudience: requireString(target.audience, "target.audience"),
          expectedResource: requireString(target.resource, "target.resource"),
          allowedScopes: target.allowedScopes,
          consumedNonces,
          maxLifetimeSec: 300,
          now: Math.floor(at.getTime() / 1000),
        },
      ).claims;
    } catch (error) {
      return deny({
        requestId,
        reasonCode: mapIdJagError(error, nonceReplayReasonCode),
        subject: auditSubject,
        target: auditTarget,
        at,
      });
    }

    const expiresAt = new Date(parsed.exp * 1000).toISOString();
    const events = grantAndUse({
      requestId,
      subject: parsed.subject,
      target: auditTarget,
      audience: parsed.aud,
      scopes: parsed.scope,
      tokenRef: `identity://id-jag/${target.id}/${parsed.nonce}`,
      expiresAt,
      operation,
      resource: parsed.resource,
      at,
    });

    return {
      ok: true,
      requestId,
      credentialType: targetKind === "hobo-app" ? "inbound-id-jag" : "id-jag",
      nonce: parsed.nonce,
      expiresAt,
      events,
    };
  }

  function useProviderAccessToken(input) {
    const requestId = requireString(input.requestId, "requestId");
    const at = dateForAttempt(input.at, now);
    const credential = normalizeProviderCredential(input.credential);
    const target = { kind: "external-app", id: requireString(input.target.id, "target.id") };

    if (Date.parse(credential.expiresAt) <= at.getTime()) {
      return deny({
        requestId,
        reasonCode: "provider-access-token-expired",
        subject: input.subject,
        target,
        at,
      });
    }

    if (credential.audience !== input.target.audience) {
      return deny({
        requestId,
        reasonCode: "provider-access-token-audience-mismatch",
        subject: input.subject,
        target,
        at,
      });
    }

    const events = grantAndUse({
      requestId,
      subject: input.subject,
      target,
      audience: credential.audience,
      scopes: credential.scopes,
      tokenRef: credential.tokenRef,
      expiresAt: credential.expiresAt,
      operation: input.operation ?? "external-app.call",
      resource: input.resource ?? input.target.resource,
      at,
    });

    return {
      ok: true,
      requestId,
      credentialType: "provider-access-token",
      expiresAt: credential.expiresAt,
      events,
    };
  }

  function redeemOutboundIdJagBatch(attempts) {
    if (!Array.isArray(attempts)) {
      throw new Error("attempts must be an array");
    }
    return attempts.map((attempt) => redeemOutboundIdJag(attempt));
  }

  return Object.freeze({
    events: () => emittedEvents.map(clone),
    useJwtSvid,
    redeemOutboundIdJag,
    redeemInboundIdJag,
    redeemOutboundIdJagBatch,
    useProviderAccessToken,
  });
}

export function createFixtureReplayCredentials(options = {}) {
  const now = dateForAttempt(options.now ?? DEFAULT_NOW, () => new Date(DEFAULT_NOW));
  const nowSec = Math.floor(now.getTime() / 1000);
  const issuer = options.issuer ?? DEFAULT_ISSUER;
  const subject = options.subject ?? DEFAULT_SUBJECT;
  const asana = options.asana ?? DEFAULT_ASANA;
  const hoboApp = options.hoboApp ?? DEFAULT_HOBO_APP;

  return deepFreeze({
    jwtSvid: {
      current: fixtureJwtSvid({
        issuer,
        kid: "kid-current",
        audience: DEFAULT_SVID_AUDIENCE,
        issuedAt: nowSec - 60,
        notBefore: nowSec - 60,
        expiresAt: nowSec + 300,
      }),
      expired: fixtureJwtSvid({
        issuer,
        kid: "kid-current",
        audience: DEFAULT_SVID_AUDIENCE,
        issuedAt: nowSec - 600,
        notBefore: nowSec - 600,
        expiresAt: nowSec - 1,
      }),
      expiresAtNow: fixtureJwtSvid({
        issuer,
        kid: "kid-current",
        audience: DEFAULT_SVID_AUDIENCE,
        issuedAt: nowSec - 60,
        notBefore: nowSec - 60,
        expiresAt: nowSec,
      }),
      previousKid: fixtureJwtSvid({
        issuer,
        kid: "kid-previous",
        audience: DEFAULT_SVID_AUDIENCE,
        issuedAt: nowSec - 60,
        notBefore: nowSec - 60,
        expiresAt: nowSec + 600,
      }),
    },
    idJag: {
      outbound: fixtureIdJag({
        issuer,
        subject,
        audience: asana.audience,
        resource: asana.resource,
        scopes: ["tasks:write"],
        nonce: "nonce-outbound",
        issuedAt: nowSec - 30,
        expiresAt: nowSec + 240,
      }),
      inbound: fixtureIdJag({
        issuer,
        subject,
        audience: hoboApp.audience,
        resource: hoboApp.resource,
        scopes: ["orders:read"],
        nonce: "nonce-inbound",
        issuedAt: nowSec - 30,
        expiresAt: nowSec + 240,
      }),
      expiresAtNow: fixtureIdJag({
        issuer,
        subject,
        audience: asana.audience,
        resource: asana.resource,
        scopes: ["tasks:write"],
        nonce: "nonce-expired-boundary",
        issuedAt: nowSec - 60,
        expiresAt: nowSec,
      }),
      concurrent: fixtureIdJag({
        issuer,
        subject,
        audience: asana.audience,
        resource: asana.resource,
        scopes: ["tasks:write"],
        nonce: "nonce-concurrent",
        issuedAt: nowSec - 30,
        expiresAt: nowSec + 240,
      }),
    },
    providerAccessToken: {
      current: {
        tokenRef: "vault://tokens/asana/current",
        audience: asana.audience,
        scopes: ["tasks:write"],
        expiresAt: new Date((nowSec + 240) * 1000).toISOString(),
      },
      expired: {
        tokenRef: "vault://tokens/asana/expired",
        audience: asana.audience,
        scopes: ["tasks:write"],
        expiresAt: new Date((nowSec - 1) * 1000).toISOString(),
      },
      expiresAtNow: {
        tokenRef: "vault://tokens/asana/expires-at-now",
        audience: asana.audience,
        scopes: ["tasks:write"],
        expiresAt: new Date(nowSec * 1000).toISOString(),
      },
    },
  });
}

function fixtureIdJag({
  issuer,
  subject,
  audience,
  resource,
  scopes,
  nonce,
  issuedAt,
  expiresAt,
}) {
  return createFixtureIdJag({
    issuer,
    subjectId: subject.delegatedBy.id,
    subject,
    audience,
    resource,
    clientId: subject.id,
    scopes,
    nonce,
    issuedAt,
    expiresAt,
  });
}

function fixtureJwtSvid({ issuer, kid, audience, issuedAt, notBefore, expiresAt }) {
  return [
    base64urlJson({ alg: "RS256", kid, typ: "JWT" }),
    base64urlJson({
      iss: issuer,
      sub: "spiffe://yard/tenant-a/agent/triage",
      aud: audience,
      tenant: "tenant-a",
      parentPrincipal: { kind: "user", id: "priya" },
      codeVersion: {
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        version: "git:hobo-255",
      },
      scope: [
        {
          port: "database/main",
          resource: "orders",
          verbs: ["read"],
        },
      ],
      iat: issuedAt,
      nbf: notBefore,
      exp: expiresAt,
    }),
    Buffer.from("fixture-svid-signature", "utf8").toString("base64url"),
  ].join(".");
}

function mapJwtSvidError(error) {
  const message = errorMessage(error);
  if (/expired/i.test(message)) {
    return "jwt-svid-expired";
  }
  if (/audience/i.test(message)) {
    return "jwt-svid-audience-mismatch";
  }
  return "invalid-credential";
}

function mapIdJagError(error, nonceReplayReasonCode) {
  const message = errorMessage(error);
  if (/nonce replay/i.test(message)) {
    return nonceReplayReasonCode;
  }
  if (/audience mismatch/i.test(message)) {
    return "id-jag-audience-mismatch";
  }
  if (/resource mismatch/i.test(message)) {
    return "id-jag-resource-mismatch";
  }
  if (/expired/i.test(message)) {
    return "id-jag-expired";
  }
  return "invalid-credential";
}

function normalizeProviderCredential(value) {
  assertObject(value, "credential");
  const expiresAt = requireIso(value.expiresAt, "credential.expiresAt");
  return {
    tokenRef: requireString(value.tokenRef, "credential.tokenRef"),
    audience: requireString(value.audience, "credential.audience"),
    scopes: normalizeScopes(value.scopes),
    expiresAt,
  };
}

function buildIdentityEvent(type, data, overrides) {
  const event = createIdentityEvent(type, data, overrides);
  const validation = validateIdentityEvent(event);
  if (!validation.ok) {
    throw new Error(`invalid ${type} event: ${validation.errors.join("; ")}`);
  }
  return event;
}

function subjectFromSvid(parsed) {
  const subject = {
    kind: "agent",
    id: `agent:${parsed.identity.agent}`,
  };
  if (parsed.claims.parentPrincipal.kind === "user" || parsed.claims.parentPrincipal.kind === "agent") {
    subject.delegatedBy = {
      kind: parsed.claims.parentPrincipal.kind,
      id: principalAuditId(parsed.claims.parentPrincipal),
    };
  }
  return subject;
}

function subjectFromIdJagAssertion(assertion) {
  try {
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString("utf8"));
    return subjectForAudit(claims.subject);
  } catch {
    return { kind: "service", id: "yard/identity" };
  }
}

function subjectForAudit(subject) {
  if (!subject || !isJsonObject(subject) || Array.isArray(subject)) {
    return { kind: "service", id: "yard/identity" };
  }
  const kind = subject.kind === "workload" ? "service" : subject.kind;
  const normalized = {
    kind: ["user", "agent", "service"].includes(kind) ? kind : "service",
    id: requireString(subject.id, "subject.id"),
  };
  if (subject.delegatedBy?.kind === "user" || subject.delegatedBy?.kind === "agent") {
    normalized.delegatedBy = clone(subject.delegatedBy);
  }
  return normalized;
}

function principalAuditId(principal) {
  if (principal.id.startsWith(`${principal.kind}:`)) {
    return principal.id;
  }
  return `${principal.kind}:${principal.id}`;
}

function normalizeTargetForAudit(target) {
  assertObject(target, "target");
  return {
    kind: requireString(target.kind, "target.kind"),
    id: requireString(target.id, "target.id"),
  };
}

function scopeStringsFromSvid(scope) {
  return scope.flatMap((grant) =>
    grant.verbs.map((verb) => `${grant.port}:${grant.resource}:${verb}`),
  );
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("scopes must be a non-empty array");
  }
  return [...new Set(scopes.map((scope, index) => requireString(scope, `scopes[${index}]`)))].sort();
}

function audienceIncludes(audience, expected) {
  return Array.isArray(audience) ? audience.includes(expected) : audience === expected;
}

function normalizeRetiredKeys(retiredKeyAcceptUntilByKid) {
  return new Map(
    Object.entries(retiredKeyAcceptUntilByKid).map(([kid, acceptUntil]) => [
      kid,
      Date.parse(acceptUntil),
    ]),
  );
}

function isKidAccepted(kid, at, retiredKeyAcceptUntilByKid) {
  const acceptUntilMs = retiredKeyAcceptUntilByKid.get(kid);
  return acceptUntilMs === undefined || at.getTime() <= acceptUntilMs;
}

function reasonForCode(reasonCode) {
  return REPLAY_REJECTION_REASONS[reasonCode] ?? REPLAY_REJECTION_REASONS["invalid-credential"];
}

function dateForAttempt(value, now) {
  if (value === undefined) {
    const current = now();
    if (!(current instanceof Date) || Number.isNaN(current.getTime())) {
      throw new Error("now() must return a valid Date");
    }
    return current;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("attempt time must be ISO-8601");
  }
  return date;
}

function requireIso(value, field) {
  const raw = requireString(value, field);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} must be ISO-8601`);
  }
  return parsed.toISOString();
}

function assertObject(value, field) {
  if (value === null || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function requireString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function defaultIdFactory() {
  const next = new Map();
  return (prefix) => {
    const value = (next.get(prefix) ?? 0) + 1;
    next.set(prefix, value);
    return `${prefix}-${value}`;
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
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
