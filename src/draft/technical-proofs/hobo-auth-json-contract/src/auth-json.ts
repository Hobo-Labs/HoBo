import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const AUTH_JSON_SCHEMA_ID = "https://hobo.dev/schemas/capability/auth-json.v1.json";
export const ID_JAG_DRAFT_VERSION = "draft-ietf-oauth-identity-assertion-authz-grant-04";
export const FLOW_PREFERENCE = [
  "oidc-federation",
  "oauth2-xaa",
  "oauth2-obo",
  "device-code",
  "api-key",
];

const FLOW_TYPES = new Set(FLOW_PREFERENCE);
const AUDIT_EVENT_PATTERN = /^(token|identity|session|secret|config)\.[A-Z][A-Za-z0-9]+$/;
const HEADER_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
const STATIC_SECRET_WARNING = "last-resort-static-secret";

export function parseAuthJson(input, options = {}) {
  assertAllowedProperties(input, "auth.json", [
    "issuer",
    "flows",
    "scopeModel",
    "resourceIndicators",
    "tokenLifetimeSec",
    "audit",
  ]);

  const issuer = normalizeHttpsUrl(input.issuer, "issuer");
  const flows = normalizeFlows(input.flows, options);
  const scopeModel = assertEnum(
    input.scopeModel,
    "scopeModel",
    ["least-privilege-per-resource"],
  );
  const resourceIndicators = parseResourceIndicators(input.resourceIndicators).map(
    (indicator) => indicator.raw,
  );
  const tokenLifetimeSec = assertPositiveInteger(
    input.tokenLifetimeSec,
    "tokenLifetimeSec",
    { max: 86_400 },
  );
  const audit = normalizeAudit(input.audit);

  return {
    issuer,
    flows,
    scopeModel,
    resourceIndicators,
    tokenLifetimeSec,
    audit,
  };
}

export function parseResourceIndicators(indicators) {
  if (!Array.isArray(indicators) || indicators.length === 0) {
    throw new Error("resourceIndicators must be a non-empty array");
  }

  const seen = new Set();
  return indicators.map((raw, index) => {
    if (!isJsonString(raw) || raw.length === 0) {
      throw new Error(`resourceIndicators[${index}] must be a non-empty string`);
    }
    if (seen.has(raw)) {
      throw new Error(`duplicate resource indicator '${raw}'`);
    }
    seen.add(raw);

    if (raw.startsWith("urn:")) {
      const [, namespace, ...rest] = raw.split(":");
      if (!namespace || rest.length === 0 || rest.some((segment) => !segment)) {
        throw new Error(`resource indicator '${raw}' must be urn:<namespace>:<resource>`);
      }
      return {
        raw,
        scheme: "urn",
        namespace,
        resource: rest.join(":"),
      };
    }

    const url = parseUrl(raw, "resource indicator");
    return {
      raw,
      scheme: url.protocol.slice(0, -1),
      host: url.hostname,
      resource: `${url.pathname}${url.search}`,
    };
  });
}

export function selectPreferredAuthFlow(authJson) {
  const manifest = authJson?.flows ? authJson : parseAuthJson(authJson);
  if (!Array.isArray(manifest.flows) || manifest.flows.length === 0) {
    throw new Error("auth.json must include at least one flow");
  }

  const [flow] = [...manifest.flows].sort(compareFlows);
  const warnings = flow.type === "api-key" ? [STATIC_SECRET_WARNING] : [];

  return {
    flow,
    preference: FLOW_PREFERENCE.indexOf(flow.type),
    warnings,
  };
}

export function buildSignedAuthManifestEnvelope(auth, options = {}) {
  const parsed = parseAuthJson(auth, options);
  const issuer = normalizeHttpsUrl(options.issuer ?? parsed.issuer, "signature issuer");
  if (issuer !== parsed.issuer) {
    throw new Error("signature issuer must match auth.json issuer");
  }

  const keyId = assertNonEmptyString(options.keyId, "signature keyId");
  const signature = {
    alg: "HOBO-FIXTURE-SHA256",
    issuer,
    keyId,
    digest: authDigest(parsed, issuer, keyId),
  };

  return {
    auth: parsed,
    signature,
  };
}

export function verifySignedAuthManifestEnvelope(envelope, options = {}) {
  assertObject(envelope, "manifest envelope");
  if (!envelope.signature) {
    throw new Error("unsigned auth.json manifest entry is rejected");
  }

  const signature = normalizeSignature(envelope.signature);
  if (options.trustedIssuer) {
    const trustedIssuer = normalizeHttpsUrl(options.trustedIssuer, "trustedIssuer");
    if (signature.issuer !== trustedIssuer) {
      throw new Error("manifest signature issuer does not match trusted issuer");
    }
  }

  const auth = parseAuthJson(envelope.auth, options);
  if (auth.issuer !== signature.issuer) {
    throw new Error("auth.json issuer does not match signature issuer");
  }

  const expectedDigest = authDigest(auth, signature.issuer, signature.keyId);
  if (signature.digest !== expectedDigest) {
    throw new Error("auth.json signature digest mismatch");
  }

  return {
    auth,
    signature,
  };
}

function normalizeFlows(flows, options) {
  if (!Array.isArray(flows) || flows.length === 0) {
    throw new Error("flows must be a non-empty array");
  }

  const normalized = flows.map((flow, index) => normalizeFlow(flow, index, options));
  const seenTypes = new Set();
  for (const flow of normalized) {
    if (seenTypes.has(flow.type)) {
      throw new Error(`duplicate auth flow type '${flow.type}' is not allowed`);
    }
    seenTypes.add(flow.type);
  }

  return normalized.sort(compareFlows);
}

function normalizeFlow(flow, index, options) {
  const field = `flows[${index}]`;
  assertObject(flow, field);
  const type = assertEnum(flow.type, `flows[${index}].type`, FLOW_PREFERENCE);

  if (!FLOW_TYPES.has(type)) {
    throw new Error(`unsupported auth flow '${type}'`);
  }

  if (type === "oidc-federation") {
    assertAllowedProperties(flow, field, ["type", "audience", "exchange", "trust"]);
    assertAllowedProperties(flow.trust, `${field}.trust`, ["oidcDiscovery"]);
    const oidcDiscovery = normalizeHttpsUrl(
      flow.trust?.oidcDiscovery,
      `flows[${index}].trust.oidcDiscovery`,
    );
    if (options.trustedOidcDiscoveryHost) {
      const actualHost = parseUrl(oidcDiscovery, "oidcDiscovery").hostname;
      if (actualHost !== options.trustedOidcDiscoveryHost) {
        throw new Error(
          `oidcDiscovery host mismatch: expected ${options.trustedOidcDiscoveryHost}, got ${actualHost}`,
        );
      }
    }

    return {
      type,
      audience: assertNonEmptyString(flow.audience, `flows[${index}].audience`),
      exchange: assertNonEmptyString(flow.exchange, `flows[${index}].exchange`),
      trust: {
        oidcDiscovery,
      },
    };
  }

  if (type === "oauth2-obo") {
    assertAllowedProperties(flow, field, ["type", "authorizationServer", "scopes"]);
    return {
      type,
      authorizationServer: normalizeHttpsUrl(
        flow.authorizationServer,
        `flows[${index}].authorizationServer`,
      ),
      scopes: normalizeScopes(flow.scopes, `flows[${index}].scopes`),
    };
  }

  if (type === "oauth2-xaa") {
    assertAllowedProperties(flow, field, [
      "type",
      "idJag",
      "idJagDraftVersion",
      "authorizationServer",
      "audience",
      "scopes",
    ]);
    if (flow.idJag !== true) {
      throw new Error(`flows[${index}].idJag must be true for oauth2-xaa`);
    }
    if (flow.idJagDraftVersion !== ID_JAG_DRAFT_VERSION) {
      throw new Error(
        `flows[${index}].idJagDraftVersion must be ${ID_JAG_DRAFT_VERSION}`,
      );
    }

    return {
      type,
      idJag: true,
      idJagDraftVersion: ID_JAG_DRAFT_VERSION,
      authorizationServer: normalizeHttpsUrl(
        flow.authorizationServer,
        `flows[${index}].authorizationServer`,
      ),
      audience: assertNonEmptyString(flow.audience, `flows[${index}].audience`),
      scopes: normalizeScopes(flow.scopes, `flows[${index}].scopes`),
    };
  }

  if (type === "device-code") {
    assertAllowedProperties(flow, field, ["type", "authorizationServer"]);
    const normalized = { type };
    if (flow.authorizationServer !== undefined) {
      normalized.authorizationServer = normalizeHttpsUrl(
        flow.authorizationServer,
        `flows[${index}].authorizationServer`,
      );
    }
    return normalized;
  }

  assertAllowedProperties(flow, field, ["type", "header", "rotation"]);
  return {
    type,
    header: assertHeader(flow.header, `flows[${index}].header`),
    rotation: assertEnum(flow.rotation, `flows[${index}].rotation`, [
      "manual",
      "automatic",
      "brokered",
    ]),
  };
}

function normalizeScopes(scopes, field) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }

  const seen = new Set();
  return scopes
    .map((scope, index) => {
      const value = assertNonEmptyString(scope, `${field}[${index}]`);
      if (seen.has(value)) {
        throw new Error(`duplicate scope '${value}'`);
      }
      seen.add(value);
      return value;
    })
    .sort();
}

function normalizeAudit(audit) {
  assertAllowedProperties(audit, "audit", ["events"]);
  if (!Array.isArray(audit.events) || audit.events.length === 0) {
    throw new Error("audit.events must be a non-empty array");
  }

  const events = audit.events.map((event, index) => {
    const value = assertNonEmptyString(event, `audit.events[${index}]`);
    if (!AUDIT_EVENT_PATTERN.test(value)) {
      throw new Error(`audit event '${value}' is not a valid HoBo event name`);
    }
    return value;
  });

  for (const requiredEvent of ["token.Granted", "token.Used"]) {
    if (!events.includes(requiredEvent)) {
      throw new Error(`audit.events must include ${requiredEvent}`);
    }
  }

  return {
    events: [...new Set(events)].sort(),
  };
}

function normalizeSignature(signature) {
  assertAllowedProperties(signature, "signature", ["alg", "issuer", "keyId", "digest"]);
  const alg = assertEnum(signature.alg, "signature.alg", ["HOBO-FIXTURE-SHA256"]);
  const issuer = normalizeHttpsUrl(signature.issuer, "signature.issuer");
  const keyId = assertNonEmptyString(signature.keyId, "signature.keyId");
  const digest = assertNonEmptyString(signature.digest, "signature.digest");
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error("signature.digest must be sha256:<64 lowercase hex chars>");
  }

  return {
    alg,
    issuer,
    keyId,
    digest,
  };
}

function authDigest(auth, issuer, keyId) {
  return `sha256:${createHash("sha256")
    .update(canonicalJson({ auth, issuer, keyId }), "utf8")
    .digest("hex")}`;
}

function compareFlows(a, b) {
  const preference = FLOW_PREFERENCE.indexOf(a.type) - FLOW_PREFERENCE.indexOf(b.type);
  if (preference !== 0) {
    return preference;
  }
  return canonicalJson(a).localeCompare(canonicalJson(b));
}

function canonicalJson(value) {
  return JSON.stringify(sortForJson(value));
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

function normalizeUrl(value, field) {
  const url = parseUrl(value, field);
  if (url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash) {
    return url.origin;
  }
  return url.href;
}

function normalizeHttpsUrl(value, field) {
  const url = parseUrl(value, field);
  if (url.protocol !== "https:") {
    throw new Error(`${field} must use https:`);
  }
  return normalizeUrl(value, field);
}

function parseUrl(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty URL string`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }

  if (!["https:", "urn:"].includes(url.protocol)) {
    throw new Error(`${field} must use https: or urn:`);
  }

  if (url.protocol === "https:" && !url.hostname) {
    throw new Error(`${field} must include a host`);
  }

  return url;
}

function assertObject(value, field) {
  if (value === null || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
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

function assertEnum(value, field, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw new Error(`${field} must be one of ${allowedValues.join(", ")}`);
  }
  return value;
}

function assertNonEmptyString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function assertHeader(value, field) {
  const header = assertNonEmptyString(value, field);
  if (!HEADER_PATTERN.test(header)) {
    throw new Error(`${field} must be an HTTP header name`);
  }
  return header;
}

function assertPositiveInteger(value, field, options = {}) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${field} must be <= ${options.max}`);
  }
  return value;
}
