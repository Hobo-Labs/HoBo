import { isJsonString, isJsonObject } from "./json.js";
export const ID_JAG_DRAFT_VERSION = "draft-ietf-oauth-identity-assertion-authz-grant-04";
export const ID_JAG_SCHEMA_ID =
  "https://hobo.dev/schemas/identity/id-jag-token-exchange.v1.json";
export const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
export const ID_JAG_GRANT_PROFILE = "urn:ietf:params:oauth:grant-profile:id-jag";

const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const ID_JAG_JWT_TYPE = "oauth-id-jag+jwt";
const TOKEN_TYPES = new Set([
  "urn:ietf:params:oauth:token-type:id_token",
  "urn:ietf:params:oauth:token-type:jwt",
]);
const DENIED_SCOPES = new Set(["*", "admin", "manage"]);

export function buildIdJagTokenExchangeRequest(input) {
  assertObject(input, "token exchange input");
  const request = {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    requested_token_type: ID_JAG_TOKEN_TYPE,
    audience: assertNonEmptyString(input.audience, "audience"),
    resource: assertNonEmptyString(input.resource, "resource"),
    scope: normalizeScopes(input.scopes, { allowedScopes: input.allowedScopes }).join(" "),
    subject_token: assertNonEmptyString(input.subjectToken, "subjectToken"),
    subject_token_type: assertTokenType(input.subjectTokenType, "subjectTokenType"),
  };

  if (input.clientAssertion !== undefined) {
    request.client_assertion_type = CLIENT_ASSERTION_TYPE;
    request.client_assertion = assertNonEmptyString(input.clientAssertion, "clientAssertion");
  }

  return request;
}

export function parseIdJagTokenExchangeResponse(response, options = {}) {
  assertAllowedProperties(response, "token exchange response", [
    "issued_token_type",
    "access_token",
    "token_type",
    "scope",
    "expires_in",
  ]);
  if (response.issued_token_type !== ID_JAG_TOKEN_TYPE) {
    throw new Error("issued_token_type must be urn:ietf:params:oauth:token-type:id-jag");
  }
  if (response.token_type !== "N_A") {
    throw new Error("token_type must be N_A for an ID-JAG response");
  }
  assertPositiveInteger(response.expires_in, "expires_in");

  const accessToken = assertNonEmptyString(response.access_token, "access_token");
  const claims = parseIdJagCompact(accessToken, options);
  const responseScopes = parseScopeString(response.scope, "scope");
  if (!sameStringList(responseScopes, claims.scope)) {
    throw new Error("token exchange response scope must match ID-JAG scope");
  }
  assertScopeSubset(claims.scope, options.allowedScopes);

  return {
    issued_token_type: ID_JAG_TOKEN_TYPE,
    access_token: accessToken,
    token_type: "N_A",
    scope: responseScopes.join(" "),
    expires_in: response.expires_in,
    claims,
  };
}

export function buildJwtBearerGrantRequest(input) {
  assertObject(input, "JWT bearer input");
  return {
    grant_type: JWT_BEARER_GRANT_TYPE,
    assertion: assertNonEmptyString(input.assertion, "assertion"),
  };
}

export function parseJwtBearerGrantRequest(request, options = {}) {
  assertAllowedProperties(request, "JWT bearer request", ["grant_type", "assertion"]);
  if (request.grant_type !== JWT_BEARER_GRANT_TYPE) {
    throw new Error("grant_type must be urn:ietf:params:oauth:grant-type:jwt-bearer");
  }

  return {
    grant_type: JWT_BEARER_GRANT_TYPE,
    assertion: assertNonEmptyString(request.assertion, "assertion"),
    claims: parseIdJagCompact(request.assertion, options),
  };
}

export function createFixtureIdJag(input) {
  assertObject(input, "ID-JAG fixture input");
  const header = {
    alg: "ES256",
    typ: ID_JAG_JWT_TYPE,
  };
  const scope = normalizeScopes(input.scopes).join(" ");
  const claims = {
    iss: normalizeHttpsUrl(input.issuer, "issuer"),
    sub: assertNonEmptyString(input.subjectId, "subjectId"),
    aud: assertNonEmptyString(input.audience, "audience"),
    resource: assertNonEmptyString(input.resource, "resource"),
    client_id: assertNonEmptyString(input.clientId, "clientId"),
    exp: assertUnixTime(input.expiresAt, "expiresAt"),
    iat: assertUnixTime(input.issuedAt, "issuedAt"),
    scope,
    nonce: assertNonEmptyString(input.nonce, "nonce"),
    jti: assertNonEmptyString(input.nonce, "nonce"),
    subject: normalizeDelegatedSubject(input.subject),
    grant_profile: ID_JAG_GRANT_PROFILE,
    idJagDraftVersion: ID_JAG_DRAFT_VERSION,
    ...(input.extraClaims),
  };

  if (claims.exp <= claims.iat) {
    throw new Error("expiresAt must be after issuedAt");
  }

  return `${base64urlJson(header)}.${base64urlJson(claims)}.${Buffer.from(
    "fixture-signature",
    "utf8",
  ).toString("base64url")}`;
}

function parseIdJagCompact(token, options) {
  const parts = String(token).split(".");
  if (parts.length !== 3) {
    throw new Error("ID-JAG compact JWT must have three segments");
  }

  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (!encodedSignature) {
    throw new Error("ID-JAG compact JWT must be signed");
  }

  const header = decodeJwtJson(encodedHeader, "header");
  if (header.typ !== ID_JAG_JWT_TYPE) {
    throw new Error(`ID-JAG header typ must be ${ID_JAG_JWT_TYPE}`);
  }
  if (!header.alg || String(header.alg).toLowerCase() === "none") {
    throw new Error("ID-JAG alg none is rejected");
  }

  const rawClaims = decodeJwtJson(encodedClaims, "claims");
  const claims = normalizeIdJagClaims(rawClaims, options);
  if (options.consumedNonces) {
    if (!(options.consumedNonces instanceof Set)) {
      throw new Error("consumedNonces must be a Set");
    }
    if (options.consumedNonces.has(claims.nonce)) {
      throw new Error(`nonce replay detected: ${claims.nonce}`);
    }
    options.consumedNonces.add(claims.nonce);
  }

  return claims;
}

function normalizeIdJagClaims(claims, options) {
  assertObject(claims, "ID-JAG claims");
  const normalized = {
    iss: normalizeHttpsUrl(claims.iss, "iss"),
    sub: assertNonEmptyString(claims.sub, "sub"),
    aud: assertNonEmptyString(claims.aud, "aud"),
    resource: assertNonEmptyString(claims.resource, "resource"),
    client_id: assertNonEmptyString(claims.client_id, "client_id"),
    exp: assertUnixTime(claims.exp, "exp"),
    iat: assertUnixTime(claims.iat, "iat"),
    scope: normalizeClaimScopes(claims.scope),
    nonce: assertNonEmptyString(claims.nonce, "nonce"),
    jti: assertNonEmptyString(claims.jti, "jti"),
    subject: normalizeDelegatedSubject(claims.subject),
    grant_profile: assertConst(claims.grant_profile, ID_JAG_GRANT_PROFILE, "grant_profile"),
    idJagDraftVersion: assertConst(
      claims.idJagDraftVersion,
      ID_JAG_DRAFT_VERSION,
      "idJagDraftVersion",
    ),
  };

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (normalized.exp <= now) {
    throw new Error("ID-JAG assertion is expired");
  }
  if (normalized.iat > now + 60) {
    throw new Error("ID-JAG iat is in the future");
  }
  if (options.maxLifetimeSec !== undefined) {
    assertPositiveInteger(options.maxLifetimeSec, "maxLifetimeSec");
    if (normalized.exp - normalized.iat > options.maxLifetimeSec) {
      throw new Error("ID-JAG assertion exceeds short-lived maxLifetimeSec");
    }
  }
  if (normalized.jti !== normalized.nonce) {
    throw new Error("ID-JAG jti must match nonce for replay accounting");
  }
  if (options.expectedAudience && normalized.aud !== options.expectedAudience) {
    throw new Error(
      `audience mismatch: expected ${options.expectedAudience}, got ${normalized.aud}`,
    );
  }
  if (options.expectedResource && normalized.resource !== options.expectedResource) {
    throw new Error(
      `resource mismatch: expected ${options.expectedResource}, got ${normalized.resource}`,
    );
  }
  assertScopeSubset(normalized.scope, options.allowedScopes);
  normalized.extraClaims = collectExtraClaims(claims, [
    "iss",
    "sub",
    "aud",
    "resource",
    "client_id",
    "exp",
    "iat",
    "scope",
    "nonce",
    "jti",
    "subject",
    "grant_profile",
    "idJagDraftVersion",
  ]);

  return normalized;
}

function normalizeDelegatedSubject(subject) {
  assertAllowedProperties(subject, "subject", ["kind", "id", "delegatedBy"]);
  const normalized = {
    kind: assertEnum(subject.kind, "subject.kind", ["agent", "service", "workload"]),
    id: assertNonEmptyString(subject.id, "subject.id"),
  };

  assertAllowedProperties(subject.delegatedBy, "subject.delegatedBy", ["kind", "id"]);
  normalized.delegatedBy = {
    kind: assertConst(subject.delegatedBy.kind, "user", "subject.delegatedBy.kind"),
    id: assertNonEmptyString(subject.delegatedBy.id, "subject.delegatedBy.id"),
  };

  return normalized;
}

function normalizeClaimScopes(scope) {
  if (isJsonString(scope)) {
    return parseScopeString(scope, "scope");
  }
  return normalizeScopes(scope);
}

function normalizeScopes(scopes, options = {}) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error("scopes must be a non-empty array");
  }
  const seen = new Set();
  const normalized = scopes.map((scope, index) => {
    const value = assertNonEmptyString(scope, `scopes[${index}]`);
    if (/\s/.test(value)) {
      throw new Error(`scope '${value}' must not contain whitespace`);
    }
    if (DENIED_SCOPES.has(value)) {
      throw new Error(`ambient scope '${value}' is not allowed`);
    }
    if (seen.has(value)) {
      throw new Error(`duplicate scope '${value}'`);
    }
    seen.add(value);
    return value;
  });
  assertScopeSubset(normalized, options.allowedScopes);
  return normalized.sort();
}

function parseScopeString(scope, field) {
  const value = assertNonEmptyString(scope, field);
  return normalizeScopes(value.split(" ").filter(Boolean));
}

function assertTokenType(value, field) {
  const tokenType = assertNonEmptyString(value, field);
  if (!TOKEN_TYPES.has(tokenType)) {
    throw new Error(`${field} is not an allowed OAuth token type`);
  }
  return tokenType;
}

function assertScopeSubset(scopes, allowedScopes) {
  if (allowedScopes === undefined) {
    return;
  }
  const allowed = new Set(normalizeScopes(allowedScopes));
  for (const scope of scopes) {
    if (!allowed.has(scope)) {
      throw new Error(`scope '${scope}' is outside allowed scopes`);
    }
  }
}

function collectExtraClaims(claims, knownClaimNames) {
  const known = new Set(knownClaimNames);
  const extraClaims = {};
  for (const [key, value] of Object.entries(claims)) {
    if (!known.has(key)) {
      extraClaims[key] = value;
    }
  }
  return extraClaims;
}

function decodeJwtJson(part, label) {
  if (!part) {
    throw new Error(`ID-JAG ${label} segment is missing`);
  }
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new Error(`ID-JAG ${label} segment is not valid base64url JSON`);
  }
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function normalizeHttpsUrl(value, field) {
  const url = parseUrl(value, field);
  if (url.protocol !== "https:") {
    throw new Error(`${field} must use https:`);
  }
  if (url.pathname === "/" && !url.search && !url.hash) {
    return url.origin;
  }
  return url.href;
}

function parseUrl(value, field) {
  const raw = assertNonEmptyString(value, field);
  try {
    return new URL(raw);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
}

function assertAllowedProperties(value, field, allowedProperties) {
  assertObject(value, field);
  const allowed = new Set(allowedProperties);
  for (const property of Object.keys(value)) {
    if (!allowed.has(property)) {
      throw new Error(`${field} has unexpected property '${property}'`);
    }
  }
}

function assertObject(value, field) {
  if (value === null || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function assertNonEmptyString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function assertPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function assertUnixTime(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a positive integer Unix timestamp`);
  }
  return value;
}

function assertConst(value, expected, field) {
  if (value !== expected) {
    throw new Error(`${field} must be ${expected}`);
  }
  return value;
}

function assertEnum(value, field, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw new Error(`${field} must be one of ${allowedValues.join(", ")}`);
  }
  return value;
}

function sameStringList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
