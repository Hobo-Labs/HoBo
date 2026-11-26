import {
  createHash,
  createHmac,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";

import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


const SUPPORTED_ALGORITHMS = new Set(["RS256"]);

export function createFixtureIdentityProvider({ issuer, keyId }) {
  const keys = new Map();
  addKey(keys, keyId);

  return createFixtureProvider({ issuer, activeKeyId: keyId, keys });
}

export function createHoboAuthVerifier({ authPort, now, eventSink = () => {} }) {
  const config = normalizeAuthPort(authPort);
  const currentTime = now instanceof Function ? now : () => Math.floor(Date.now() / 1000);

  return Object.freeze({
    async verifyRequest(request) {
      try {
        const normalized = normalizeRequest(request);
        requireConfiguredProvider(normalized.provider, config);
        const verified = verifyJwt(normalized.token, config, currentTime());
        const ctx = buildContext(verified.claims, verified.header, normalized.provider, config);
        const event = buildAuthenticatedEvent({
          ctx,
          provider: normalized.provider,
          sessionId: normalized.sessionId,
          requestId: normalized.requestId,
          authTime: new Date((verified.claims.iat ?? currentTime()) * 1000).toISOString(),
        });
        eventSink(event);

        return {
          ok: true,
          ctx,
          header: verified.header,
          claims: verified.claims,
          events: [event],
        };
      } catch (error) {
        return {
          ok: false,
          error: normalizeError(error),
        };
      }
    },
  });
}

export function requireTenantAccess(ctx, tenant) {
  if (!ctx?.tenant || ctx.tenant.kind !== "resolved") {
    throw new Error("tenant unresolved; fail closed");
  }
  if (ctx.tenant.value !== tenant) {
    throw new Error(`tenant access denied: ${tenant}`);
  }
  return true;
}

function createFixtureProvider({ issuer, activeKeyId, keys }) {
  return Object.freeze({
    issuer,
    async signJwt(claims) {
      const payload = {
        ...claims,
        iss: Object.hasOwn(claims, "iss") ? claims.iss : issuer,
      };
      return signJwtWithRsa(keys.get(activeKeyId), activeKeyId, payload);
    },
    jwks() {
      return {
        keys: [...keys].map(([kid, key]) => publicJwk(kid, key.publicKey)),
      };
    },
    rotate(nextKeyId) {
      addKey(keys, nextKeyId);
      return createFixtureProvider({ issuer, activeKeyId: nextKeyId, keys });
    },
    makeUnsignedJwt(claims) {
      return `${toBase64UrlJson({ alg: "none", typ: "JWT" })}.${toBase64UrlJson({
        ...claims,
        iss: Object.hasOwn(claims, "iss") ? claims.iss : issuer,
      })}.`;
    },
    signHmacJwt(claims, secret) {
      const input = `${toBase64UrlJson({ alg: "HS256", kid: activeKeyId, typ: "JWT" })}.${toBase64UrlJson({
        ...claims,
        iss: Object.hasOwn(claims, "iss") ? claims.iss : issuer,
      })}`;
      const signature = createHmac("sha256", secret).update(input).digest();
      return `${input}.${toBase64Url(signature)}`;
    },
  });
}

function addKey(keys, keyId) {
  if (keys.has(keyId)) {
    throw new Error(`fixture IdP key already exists: ${keyId}`);
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  keys.set(keyId, { privateKey, publicKey });
}

function signJwtWithRsa(key, keyId, claims) {
  const input = `${toBase64UrlJson({ alg: "RS256", kid: keyId, typ: "JWT" })}.${toBase64UrlJson(claims)}`;
  const signature = createSign("RSA-SHA256").update(input).end().sign(key.privateKey);
  return `${input}.${toBase64Url(signature)}`;
}

function verifyJwt(token, config, now) {
  const segments = String(token).split(".");
  if (segments.length !== 3 || !segments[0] || !segments[1]) {
    throw codedError("malformed-token", "JWT must have header, claims, and signature");
  }
  const [encodedHeader, encodedClaims, encodedSignature] = segments;

  const header = parseSegment(encodedHeader, "header");
  const claims = parseSegment(encodedClaims, "claims");
  if (!SUPPORTED_ALGORITHMS.has(header.alg) || !config.algorithms.includes(header.alg)) {
    throw codedError("unsupported-alg", `unsupported JWT alg ${String(header.alg)}`);
  }
  const jwk = config.jwks.keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    throw codedError("unknown-kid", `JWKS does not publish kid ${String(header.kid)}`);
  }

  const verifier = createVerify("RSA-SHA256").update(`${encodedHeader}.${encodedClaims}`).end();
  const valid = verifier.verify(
    createPublicKey({ key: jwk, format: "jwk" }),
    fromBase64Url(encodedSignature),
  );
  if (!valid) {
    throw codedError("bad-signature", "JWT signature verification failed");
  }

  validateClaims(claims, config, now);
  return { header, claims };
}

function validateClaims(claims, config, now) {
  if (claims.iss !== config.issuer) {
    throw codedError("issuer-mismatch", "JWT issuer does not match configured auth provider");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.audience)) {
    throw codedError("audience-mismatch", "JWT audience does not include this HoBo app");
  }
  if (!Number.isFinite(claims.exp) || claims.exp <= now) {
    throw codedError("token-expired", "JWT is expired");
  }
  if (Number.isFinite(claims.nbf) && claims.nbf > now) {
    throw codedError("token-not-yet-valid", "JWT is not yet valid");
  }
}

function buildContext(claims, header, provider, config) {
  const subject = requireClaim(claims, config.subjectClaim, "subject-claim-missing");
  const tenant = claims[config.tenantClaim];
  if (!isJsonString(tenant) || tenant.length === 0) {
    throw codedError("tenant-claim-missing", "verified JWT does not resolve ctx.tenant");
  }

  const user = {
    kind: "user",
    id: subject,
    provider,
    roles: normalizeClaimStrings(claims[config.roleClaim]),
    scopes: normalizeClaimStrings(claims[config.scopeClaim]),
    tenant: { app: tenant },
    claims: clone(claims),
  };

  return {
    user,
    tenant: {
      kind: "resolved",
      value: tenant,
    },
    auth: {
      issuer: config.issuer,
      audience: config.audience,
      provider,
      kid: header.kid,
      verifiedAt: "request",
      mode: "stateless-jwks",
    },
  };
}

function buildAuthenticatedEvent({ ctx, provider, sessionId, requestId, authTime }) {
  const event = createIdentityEvent(
    "user.Authenticated",
    {
      principal: { kind: "user", id: ctx.user.id },
      provider,
      authTime,
      sessionId,
      result: "verified",
      tenant: ctx.tenant.value,
      claimDigest: `sha256:${createHash("sha256")
        .update(JSON.stringify(sortForJson(ctx.user.claims)))
        .digest("hex")}`,
    },
    {
      id: `evt-${requestId}-user-authenticated`,
      actor: { kind: "user", id: ctx.user.id },
      correlationId: requestId,
      causationId: requestId,
    },
  );
  const validation = validateIdentityEvent(event);
  if (!validation.ok) {
    throw new Error(`invalid user.Authenticated event: ${validation.errors.join("; ")}`);
  }
  return event;
}

function normalizeAuthPort(authPort) {
  assertPlainObject(authPort, "authPort");
  const jwks = authPort.jwks;
  if (!jwks || !Array.isArray(jwks.keys)) {
    throw new Error("authPort.jwks.keys must be provided");
  }
  const algorithms = normalizeStringArray(authPort.algorithms, "authPort.algorithms");
  for (const algorithm of algorithms) {
    if (!SUPPORTED_ALGORITHMS.has(algorithm)) {
      throw new Error(`authPort algorithm is unsupported: ${algorithm}`);
    }
  }
  return {
    issuer: requireString(authPort.issuer, "authPort.issuer"),
    audience: requireString(authPort.audience, "authPort.audience"),
    algorithms,
    jwks: clone(jwks),
    tenantClaim: requireString(authPort.tenantClaim, "authPort.tenantClaim"),
    subjectClaim: requireString(authPort.subjectClaim, "authPort.subjectClaim"),
    roleClaim: requireString(authPort.roleClaim, "authPort.roleClaim"),
    scopeClaim: requireString(authPort.scopeClaim, "authPort.scopeClaim"),
    providers: normalizeStringArray(authPort.providers ?? ["customJwt"], "authPort.providers"),
  };
}

function normalizeRequest(request) {
  assertPlainObject(request, "auth verify request");
  const provider = request.provider ?? "customJwt";
  return {
    token: requireString(request.token, "auth verify request token"),
    provider: requireString(provider, "auth verify request provider"),
    sessionId: request.sessionId ?? `stateless:${provider}`,
    requestId: request.requestId ?? "req-auth-verify",
  };
}

function requireConfiguredProvider(provider, config) {
  if (!config.providers.includes(provider)) {
    throw codedError("provider-unconfigured", `auth provider is not configured: ${provider}`);
  }
}

function requireClaim(claims, claimName, code) {
  const value = claims[claimName];
  if (!isJsonString(value) || value.length === 0) {
    throw codedError(code, `required claim ${claimName} is missing`);
  }
  return value;
}

function normalizeClaimStrings(value) {
  if (value === undefined) {
    return [];
  }
  if (isJsonString(value)) {
    return [value];
  }
  if (!Array.isArray(value)) {
    throw codedError("claim-shape-invalid", "role/scope claims must be strings or string arrays");
  }
  return [...new Set(value.map((entry) => requireString(entry, "claim entry")))].sort();
}

function normalizeStringArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return [...new Set(value.map((entry, index) => requireString(entry, `${field}[${index}]`)))];
}

function parseSegment(segment, field) {
  try {
    return JSON.parse(fromBase64Url(segment).toString("utf8"));
  } catch {
    throw codedError("malformed-token", `JWT ${field} is not valid base64url JSON`);
  }
}

function publicJwk(kid, publicKey) {
  return { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeError(error) {
  return {
    code: error.code ?? "auth-verification-failed",
    message: error.message,
  };
}

function toBase64UrlJson(value) {
  return toBase64Url(Buffer.from(JSON.stringify(value)));
}

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(value, "base64url");
}

function requireString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function assertPlainObject(value, field) {
  if (
    value === null ||
    !isJsonObject(value) ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${field} must be an object`);
  }
}

function sortForJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortForJson);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortForJson(value[key])]),
    );
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
