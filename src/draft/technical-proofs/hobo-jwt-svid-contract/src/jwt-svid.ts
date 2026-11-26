const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const PORT_PATTERN = /^[a-z][A-Za-z0-9:-]*\/[A-Za-z0-9._-]+$/;
const DENIED_AMBIENT_VERBS = new Set(["*", "admin", "manage"]);
const PRINCIPAL_KINDS = new Set(["user", "agent", "service", "workload"]);

export function parseSpiffeId(input, options = {}) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("SPIFFE ID must be a valid URI");
  }

  if (url.protocol !== "spiffe:") {
    throw new Error("SPIFFE ID must use the spiffe:// scheme");
  }

  const trustDomain = url.hostname;
  const expectedTrustDomain = options.expectedTrustDomain ?? "yard";
  if (trustDomain !== expectedTrustDomain) {
    throw new Error(`trust-domain mismatch: expected ${expectedTrustDomain}, got ${trustDomain}`);
  }

  const segments = url.pathname.split("/").slice(1);
  assertSegments(segments);

  const [tenant, second, third] = segments;
  if (options.expectedTenant && tenant !== options.expectedTenant) {
    throw new Error(`tenant mismatch: expected ${options.expectedTenant}, got ${tenant}`);
  }

  if (segments.length !== 3) {
    throw new Error(
      "SPIFFE ID must be spiffe://yard/<tenant>/agent/<name> or spiffe://yard/<tenant>/<bindle>/<resource>",
    );
  }

  if (second === "agent") {
    return {
      kind: "agent",
      trustDomain,
      tenant,
      agent: third,
    };
  }

  return {
    kind: "workload",
    trustDomain,
    tenant,
    bindle: second,
    resource: third,
  };
}

export function parseJwtSvidCompact(token, options = {}) {
  const parts = String(token).split(".");
  if (parts.length !== 3) {
    throw new Error("compact JWT-SVID must have three segments");
  }

  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (!encodedSignature) {
    throw new Error("unsigned JWT-SVID is rejected");
  }

  const header = decodeJwtJson(encodedHeader, "header");
  if (!header.alg || !isString(header.alg)) {
    throw new Error("JWT-SVID header must include alg");
  }
  if (header.alg.toLowerCase() === "none") {
    throw new Error("JWT-SVID alg none is rejected");
  }

  const claims = parseJwtSvidClaims(decodeJwtJson(encodedClaims, "claims"), options);

  return {
    header,
    claims,
    identity: parseSpiffeId(claims.sub, {
      expectedTenant: claims.tenant,
      expectedTrustDomain: options.expectedTrustDomain,
    }),
  };
}

export function parseJwtSvidClaims(claims, options = {}) {
  assertObject(claims, "claims");
  assertUri(claims.iss, "iss");
  assertAudience(claims.aud);
  assertUnixTime(claims.iat, "iat");
  assertUnixTime(claims.nbf, "nbf");
  assertUnixTime(claims.exp, "exp");
  assertSegment(claims.tenant, "tenant");

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (claims.exp <= now) {
    throw new Error("JWT-SVID is expired");
  }
  if (claims.nbf > now) {
    throw new Error("JWT-SVID is not yet valid");
  }
  if (claims.iat > now + 60) {
    throw new Error("JWT-SVID iat is in the future");
  }

  const identity = parseSpiffeId(claims.sub, {
    expectedTenant: options.expectedTenant ?? claims.tenant,
    expectedTrustDomain: options.expectedTrustDomain,
  });
  if (identity.tenant !== claims.tenant) {
    throw new Error(
      `tenant mismatch: subject ${identity.tenant} does not match claim ${claims.tenant}`,
    );
  }

  assertPrincipal(claims.parentPrincipal);
  assertCodeVersion(claims.codeVersion);
  assertScope(claims.scope);

  return claims;
}

function decodeJwtJson(part, label) {
  if (!part) {
    throw new Error(`JWT-SVID ${label} segment is missing`);
  }

  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new Error(`JWT-SVID ${label} segment is not valid base64url JSON`);
  }
}

function assertScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0) {
    throw new Error("scope must be a non-empty array");
  }

  for (const grant of scope) {
    assertObject(grant, "scope grant");
    if (!PORT_PATTERN.test(grant.port ?? "")) {
      throw new Error("scope grant port must be a WIT interface reference");
    }
    assertSegment(grant.resource, "scope grant resource");

    if (!Array.isArray(grant.verbs) || grant.verbs.length === 0) {
      throw new Error("scope grant verbs must be a non-empty array");
    }

    const seen = new Set();
    for (const verb of grant.verbs) {
      assertSegment(verb, "scope grant verb", 64, /^[A-Za-z0-9._:-]+$/);
      if (DENIED_AMBIENT_VERBS.has(verb)) {
        throw new Error(`ambient admin grant '${verb}' is not allowed in JWT-SVID scope`);
      }
      if (seen.has(verb)) {
        throw new Error(`duplicate scope verb '${verb}'`);
      }
      seen.add(verb);
    }
  }
}

function assertPrincipal(principal) {
  assertObject(principal, "parentPrincipal");
  if (!PRINCIPAL_KINDS.has(principal.kind)) {
    throw new Error("parentPrincipal kind is invalid");
  }
  assertSegment(principal.id, "parentPrincipal id");
  if (principal.delegatedBy !== undefined) {
    assertSegment(principal.delegatedBy, "parentPrincipal delegatedBy");
  }
}

function assertCodeVersion(codeVersion) {
  assertObject(codeVersion, "codeVersion");
  if (!/^sha256:[a-f0-9]{64}$/.test(codeVersion.digest ?? "")) {
    throw new Error("codeVersion digest must be sha256:<64 lowercase hex chars>");
  }
  if (codeVersion.version !== undefined) {
    assertSegment(codeVersion.version, "codeVersion version", 128, /^[A-Za-z0-9._:-]+$/);
  }
}

function assertAudience(audience) {
  if (isString(audience)) {
    if (!audience) {
      throw new Error("aud must not be empty");
    }
    return;
  }

  if (!Array.isArray(audience) || audience.length === 0) {
    throw new Error("aud must be a non-empty string or array");
  }

  const seen = new Set();
  for (const entry of audience) {
    if (!isNonEmptyString(entry)) {
      throw new Error("aud entries must be non-empty strings");
    }
    if (seen.has(entry)) {
      throw new Error(`duplicate aud entry '${entry}'`);
    }
    seen.add(entry);
  }
}

function assertUri(value, field) {
  if (!isString(value)) {
    throw new Error(`${field} must be a URI string`);
  }
  try {
    new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URI`);
  }
}

function assertUnixTime(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a positive integer Unix timestamp`);
  }
}

function assertObject(value, field) {
  if (!isPlainObject(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function assertSegments(segments) {
  for (const segment of segments) {
    assertSegment(segment, "SPIFFE ID segment");
  }
}

function assertSegment(value, field, maxLength = 128, pattern = SEGMENT_PATTERN) {
  if (!isString(value)) {
    throw new Error(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new Error(`${field} must not be an empty segment`);
  }
  if (value.length > maxLength) {
    throw new Error(`${field} is too long`);
  }
  if (!pattern.test(value)) {
    throw new Error(`${field} contains invalid characters`);
  }
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNonEmptyString(value) {
  return isString(value) && value.length > 0;
}

function isPlainObject(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}
