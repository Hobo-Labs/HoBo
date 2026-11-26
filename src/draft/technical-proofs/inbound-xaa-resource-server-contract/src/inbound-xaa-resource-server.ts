import {
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";

import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import { parseJwtBearerGrantRequest } from "../../id-jag-token-exchange-contract/src/id-jag-token-exchange.js";
import { isJsonString, isJsonObject } from "./json.js";


const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ID_JAG_JWT_TYPE = "oauth-id-jag+jwt";

export function createFixtureIdJagIssuer({ issuer, keyId = "kid-id-jag-1" } = {}) {
  const normalizedIssuer = requireString(issuer, "issuer");
  const keys = new Map();
  let activeKeyId = keyId;

  function addKey(kid) {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    keys.set(kid, pair);
  }

  addKey(activeKeyId);

  return Object.freeze({
    issuer: normalizedIssuer,

    rotate(nextKeyId) {
      activeKeyId = nextKeyId;
      addKey(activeKeyId);
      return this;
    },

    jwks() {
      return {
        keys: [...keys].map(([kid, pair]) => publicJwk(pair.publicKey, kid)),
      };
    },

    signIdJag(input) {
      const pair = keys.get(activeKeyId);
      const header = {
        alg: "RS256",
        kid: activeKeyId,
        typ: ID_JAG_JWT_TYPE,
      };
      const claims = {
        iss: input.issuer ?? normalizedIssuer,
        sub: requireString(input.subjectId, "subjectId"),
        aud: requireString(input.audience, "audience"),
        resource: requireString(input.resource, "resource"),
        client_id: requireString(input.clientId, "clientId"),
        exp: requireUnixTime(input.expiresAt, "expiresAt"),
        iat: requireUnixTime(input.issuedAt, "issuedAt"),
        scope: normalizeScopes(input.scopes).join(" "),
        nonce: requireString(input.nonce, "nonce"),
        jti: requireString(input.nonce, "nonce"),
        subject: clone(input.subject),
        grant_profile: "urn:ietf:params:oauth:grant-profile:id-jag",
        idJagDraftVersion: "draft-ietf-oauth-identity-assertion-authz-grant-04",
        ...input.extraClaims,
      };
      return signJwt({ header, claims, privateKey: pair.privateKey });
    },
  });
}

export function createInboundXaaResourceServer(options = {}) {
  const app = normalizeApp(options.app);
  const trustedIssuers = normalizeTrustedIssuers(options.trustedIssuers);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const idFactory = options.idFactory ?? defaultIdFactory();
  const eventSink = options.eventSink ?? (() => {});
  const consumedNonces = options.consumedNonces ?? new Set();
  const policyGate = options.policyGate ?? (async () => ({ ok: true }));
  const tokenTtlSec = options.tokenTtlSec ?? 300;

  return Object.freeze({
    async acceptIdJag(input = {}) {
      const requestId = input.requestId ?? `req-${Date.now()}`;
      const assertion = requireString(input.assertion, "assertion");
      let unverified;
      try {
        unverified = readJwt(assertion);
      } catch (error) {
        return deny({
          code: "invalid-id-jag",
          reason: error.message,
          requestId,
          subject: undefined,
        });
      }
      const trustedJwks = trustedIssuers.get(unverified.claims.iss);

      if (!trustedJwks) {
        return deny({
          code: "untrusted-issuer",
          reason: `untrusted issuer: ${unverified.claims.iss}`,
          requestId,
          subject: subjectForAudit(unverified.claims.subject),
        });
      }

      const signature = verifyJwt({ assertion, jwks: trustedJwks });
      if (!signature.ok) {
        return deny({
          code: "invalid-id-jag",
          reason: signature.reason,
          requestId,
          subject: subjectForAudit(unverified.claims.subject),
        });
      }

      let claims;
      try {
        claims = parseJwtBearerGrantRequest(
          {
            grant_type: JWT_BEARER_GRANT_TYPE,
            assertion,
          },
          {
            expectedAudience: app.audience,
            expectedResource: app.resource,
            allowedScopes: app.allowedScopes,
            maxLifetimeSec: 600,
            now: now(),
            consumedNonces,
          },
        ).claims;
      } catch (error) {
        return deny({
          code: "invalid-id-jag",
          reason: error.message,
          requestId,
          subject: subjectForAudit(unverified.claims.subject),
        });
      }

      const requiredScopes = normalizeRequiredScopes(input.requiredScopes, claims.scope);
      const missingScope = requiredScopes.find((scope) => !claims.scope.includes(scope));
      if (missingScope) {
        return deny({
          code: "insufficient-scope",
          reason: `ID-JAG assertion is missing required scope '${missingScope}'`,
          requestId,
          subject: claims.subject,
        });
      }

      const ctx = contextFromClaims({ app, claims, assertionIssuer: unverified.claims.iss });
      let decision;
      try {
        decision = await policyGate({
          requestId,
          app,
          ctx,
          scopes: requiredScopes,
          assertion: { issuer: claims.iss, nonce: claims.nonce },
        });
      } catch (error) {
        return deny({
          code: "policy-denied",
          reason: error.message,
          requestId,
          subject: claims.subject,
        });
      }
      if (decision === false || decision?.ok === false) {
        return deny({
          code: "policy-denied",
          reason: decision?.reason ?? "policy denied inbound XAA assertion",
          requestId,
          subject: claims.subject,
        });
      }

      const grantId = idFactory("grant");
      const usageId = idFactory("use");
      const expiresAt = toIso(Math.min(claims.exp, now() + tokenTtlSec));
      const credential = {
        tokenRef: `vault://tokens/inbound-xaa/${grantId}`,
        audience: app.audience,
        resource: app.resource,
        scopes: requiredScopes,
        subject: clone(claims.subject),
        expiresAt,
      };
      const events = emitEvents([
        identityEvent("token.Granted", {
          grantId,
          subject: claims.subject,
          target: appTarget(app),
          audience: app.audience,
          scopes: requiredScopes,
          tokenRef: credential.tokenRef,
          expiresAt,
        }),
        identityEvent("token.Used", {
          grantId,
          usageId,
          operation: "inbound-xaa.accept",
          resource: app.resource,
        }),
      ]);

      return {
        ok: true,
        requestId,
        ctx,
        credential,
        events,
        idJag: {
          issuer: claims.iss,
          nonce: claims.nonce,
        },
      };
    },
  });

  function deny({ code, reason, requestId, subject }) {
    const event = identityEvent("token.Denied", {
      requestId,
      subject: subjectForAudit(subject),
      target: appTarget(app),
      reason,
    });
    emitEvents([event]);
    return { ok: false, code, reason, events: [event] };
  }

  function emitEvents(events) {
    for (const event of events) {
      eventSink(event);
    }
    return events;
  }
}

export function createInboundXaaMcpBridge({ resourceServer, makeMcpServer }) {
  if (!resourceServer || !(resourceServer.acceptIdJag instanceof Function)) {
    throw new Error("resourceServer.acceptIdJag is required");
  }
  if (!(makeMcpServer instanceof Function)) {
    throw new Error("makeMcpServer is required");
  }

  return Object.freeze({
    async callTool(name, input = {}, authOptions = {}) {
      const accepted = await resourceServer.acceptIdJag(authOptions);
      if (!accepted.ok) {
        return {
          ok: false,
          error: {
            code: "inbound-xaa-denied",
            message: accepted.reason,
          },
        };
      }

      const server = makeMcpServer({
        ctx: accepted.ctx,
        credential: accepted.credential,
        identity: accepted.ctx.identity,
      });
      return server.callTool(name, input, {
        credential: accepted.credential,
      });
    },
  });
}

function verifyJwt({ assertion, jwks }) {
  const [encodedHeader, encodedClaims, encodedSignature] = assertion.split(".");
  const header = decodeJwtPart(encodedHeader, "header");
  if (header.typ !== ID_JAG_JWT_TYPE) {
    return { ok: false, reason: `ID-JAG header typ must be ${ID_JAG_JWT_TYPE}` };
  }
  if (header.alg !== "RS256") {
    return { ok: false, reason: "ID-JAG alg must be RS256" };
  }
  const key = findJwk(jwks, header.kid);
  if (!key) {
    return { ok: false, reason: `trusted JWKS does not contain kid '${header.kid}'` };
  }

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedClaims}`);
  verifier.end();
  let ok;
  try {
    ok = verifier.verify(
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(encodedSignature, "base64url"),
    );
  } catch {
    ok = false;
  }
  return ok ? { ok: true } : { ok: false, reason: "ID-JAG signature verification failed" };
}

function signJwt({ header, claims, privateKey }) {
  const encodedHeader = base64urlJson(header);
  const encodedClaims = base64urlJson(claims);
  const signer = createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedClaims}`);
  signer.end();
  const signature = signer.sign(privateKey).toString("base64url");
  return `${encodedHeader}.${encodedClaims}.${signature}`;
}

function readJwt(assertion) {
  const parts = assertion.split(".");
  if (parts.length !== 3) {
    throw new Error("ID-JAG compact JWT must have three segments");
  }
  return {
    header: decodeJwtPart(parts[0], "header"),
    claims: decodeJwtPart(parts[1], "claims"),
  };
}

function identityEvent(type, data) {
  const event = createIdentityEvent(type, data);
  const validation = validateIdentityEvent(event);
  if (!validation.ok) {
    throw new Error(`invalid ${type}: ${validation.errors.join("; ")}`);
  }
  return event;
}

function contextFromClaims({ app, claims, assertionIssuer }) {
  const delegatedUser = claims.subject.delegatedBy;
  return {
    user: {
      kind: delegatedUser.kind,
      id: delegatedUser.id,
      delegatedFrom: {
        kind: claims.subject.kind,
        id: claims.subject.id,
      },
      tenant: {
        app: claims.extraClaims.appTenant ?? app.id,
      },
    },
    identity: clone(claims.subject),
    auth: {
      kind: "inbound-xaa",
      issuer: assertionIssuer,
      audience: claims.aud,
      resource: claims.resource,
      scopes: [...claims.scope],
      nonce: claims.nonce,
    },
  };
}

function normalizeApp(app) {
  if (!app || !isJsonObject(app) || Array.isArray(app)) {
    throw new Error("app is required");
  }
  return {
    id: requireString(app.id, "app.id"),
    audience: requireString(app.audience, "app.audience"),
    resource: requireString(app.resource, "app.resource"),
    allowedScopes: normalizeScopes(app.allowedScopes),
  };
}

function normalizeTrustedIssuers(trustedIssuers = {}) {
  const entries = Object.entries(trustedIssuers);
  const normalized = new Map();
  for (const [issuer, jwks] of entries) {
    if (!jwks || !Array.isArray(jwks.keys)) {
      throw new Error(`trusted issuer ${issuer} must provide a JWKS keys array`);
    }
    normalized.set(issuer, jwks);
  }
  return normalized;
}

function normalizeRequiredScopes(scopes, fallback) {
  if (scopes === undefined) {
    return [...fallback];
  }
  return normalizeScopes(scopes);
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("scopes must be a non-empty array");
  }
  return [...new Set(scopes.map((scope) => requireString(scope, "scope")))].sort();
}

function publicJwk(publicKey, kid) {
  return {
    ...publicKey.export({ format: "jwk" }),
    kid,
    alg: "RS256",
    use: "sig",
  };
}

function findJwk(jwks, kid) {
  return jwks.keys.find((key) => key.kid === kid);
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJwtPart(part, label) {
  if (!part) {
    throw new Error(`ID-JAG ${label} segment is missing`);
  }
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new Error(`ID-JAG ${label} segment is not valid base64url JSON`);
  }
}

function requireString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireUnixTime(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a positive integer Unix timestamp`);
  }
  return value;
}

function subjectForAudit(subject) {
  if (!subject || !isJsonObject(subject) || Array.isArray(subject)) {
    return { kind: "service", id: "yard/inbound-xaa" };
  }
  const kind = subject.kind === "workload" ? "service" : subject.kind;
  const delegatedBy =
    subject.delegatedBy?.kind === "user" || subject.delegatedBy?.kind === "agent"
      ? { delegatedBy: clone(subject.delegatedBy) }
      : {};
  return {
    kind: ["user", "agent", "service"].includes(kind) ? kind : "service",
    id: isJsonString(subject.id) && subject.id.length > 0 ? subject.id : "yard/inbound-xaa",
    ...delegatedBy,
  };
}

function appTarget(app) {
  return { kind: "hobo-app", id: app.id };
}

function toIso(unixTimeSeconds) {
  return new Date(unixTimeSeconds * 1000).toISOString();
}

function defaultIdFactory() {
  const next = {
    grant: 1,
    use: 1,
  };
  return (prefix) => `${prefix}-${next[prefix]++}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
