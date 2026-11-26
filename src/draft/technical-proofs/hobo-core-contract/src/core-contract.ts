import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const CORE_SCHEMA_VERSION = "hobo.core/v1";
export const CAPABILITY_MANIFEST_SCHEMA_ID =
  "https://hobo.dev/schemas/core/capability-manifest-bundle.v1.json";

export const CORE_API_SNAPSHOT = deepFreeze({
  schemaVersion: CORE_SCHEMA_VERSION,
  packageName: "@hobo/core",
  exports: [
    "CapabilityManifestBundle",
    "Container",
    "EventEnvelope",
    "PortDescriptor",
    "ProviderPort",
    "RuntimePort",
  ],
});

const SHA256_REF = /^sha256:[a-f0-9]{64}$/;
const HTTPS_URL = /^https:\/\/[^/\s]+(?:\/[^\s]*)?$/;
const STABILITIES = new Set(["stable", "preview", "experimental"]);
const PORT_KINDS = new Set(["runtime", "provider", "port"]);
const PRINCIPAL_KINDS = new Set(["user", "agent", "service", "system"]);
const FLOW_ORDER = ["oidc-federation", "oauth2-xaa", "oauth2-obo", "device-code", "api-key"];
const FLOW_ORDER_SET = new Set(FLOW_ORDER);
const REQUIRED_MANIFEST_FILES = ["capabilities.json", "auth.json", "cost.json"];
const PROVIDER_LEAK_PATTERN = /(Aws|AWS|Azure|Gcp|GCP|GoogleCloud|Cloudflare|Hetzner|Fly|Vercel)/;
const TRACEPARENT =
  /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/;

export function parseCapabilityManifestBundle(input, options = {}) {
  const source = expectObject(input, "capability manifest bundle");
  const index = parseIndex(source.index, options);
  const capabilities = parseCapabilities(source.capabilities);
  const auth = parseAuth(source.auth, index, options);
  const cost = parseCost(source.cost);

  return deepFreeze({ index, capabilities, auth, cost });
}

export function createPortDescriptor(input) {
  const source = expectObject(input, "port descriptor");
  const descriptor = {
    kind: enumValue(source.kind, PORT_KINDS, "kind"),
    name: nonEmptyString(source.name, "name"),
    interface: parseInterfaceRef(source.interface, "interface"),
    stability: enumValue(source.stability, STABILITIES, "stability"),
  };

  return deepFreeze(descriptor);
}

export function createContainer() {
  const implementations = new Map();
  return {
    register(descriptorInput, implementation) {
      const descriptor = createPortDescriptor(descriptorInput);
      const key = portKey(descriptor);
      if (implementations.has(key)) {
        throw new Error(`port ${key} is already registered`);
      }
      implementations.set(key, implementation);
    },
    resolve(descriptorInput) {
      const descriptor = createPortDescriptor(descriptorInput);
      const key = portKey(descriptor);
      if (!implementations.has(key)) {
        throw new Error(`port ${key} is not registered`);
      }
      return implementations.get(key);
    },
  };
}

export function createEventEnvelope(input) {
  const source = expectObject(input, "event envelope");
  return parseEventEnvelope({
    id: source.id,
    type: source.type,
    v: source.v ?? 1,
    streamId: source.streamId,
    seq: source.seq,
    ts: source.ts ?? source.time,
    actor: source.actor,
    tenant: source.tenant,
    project: source.project,
    causationId: source.causationId,
    correlationId: source.correlationId,
    data: source.data,
    lane: source.lane,
    meta: source.meta,
  });
}

export function parseEventEnvelope(input) {
  const source = expectObject(input, "event envelope");
  const envelope = {
    id: nonEmptyString(source.id, "id"),
    type: nonEmptyString(source.type, "type"),
    v: nonNegativeInteger(source.v, "v"),
    streamId: nonEmptyString(source.streamId, "streamId"),
    seq: nonNegativeInteger(source.seq, "seq"),
    ts: isoTimestamp(source.ts, "ts"),
    actor: parsePrincipal(source.actor, "actor"),
    tenant: nonEmptyString(source.tenant, "tenant"),
    data: cloneJson(source.data ?? {}),
  };

  for (const key of ["project", "causationId", "correlationId", "lane"]) {
    if (source[key] !== undefined) {
      envelope[key] = nonEmptyString(source[key], key);
    }
  }
  if (source.meta !== undefined) {
    envelope.meta = canonicalJsonObject(source.meta, "meta");
  }

  return deepFreeze(envelope);
}

export function toCloudEvent(envelopeInput) {
  const envelope = parseEventEnvelope(envelopeInput);
  return deepFreeze({
    specversion: "1.0",
    id: envelope.id,
    type: envelope.type,
    source: `hobo://${envelope.tenant}/${envelope.streamId}`,
    subject: envelope.streamId,
    time: envelope.ts,
    datacontenttype: "application/json",
    data: cloneJson(envelope.data),
    hobov: envelope.v,
    hoboseq: envelope.seq,
    hoboactor: cloneJson(envelope.actor),
    hobostreamid: envelope.streamId,
    hobotenant: envelope.tenant,
    hoboproject: envelope.project,
    hobocausationid: envelope.causationId,
    hobocorrelationid: envelope.correlationId,
    hobolane: envelope.lane,
    hobometa: envelope.meta,
  });
}

export function fromCloudEvent(input) {
  const event = expectObject(input, "CloudEvent");
  return parseEventEnvelope({
    id: event.id,
    type: event.type,
    v: event.hobov,
    streamId: event.hobostreamid ?? event.subject,
    seq: event.hoboseq,
    ts: event.time,
    actor: event.hoboactor,
    tenant: event.hobotenant,
    project: event.hoboproject,
    causationId: event.hobocausationid,
    correlationId: event.hobocorrelationid,
    lane: event.hobolane,
    meta: event.hobometa,
    data: event.data,
  });
}

export function toOcsfAuditEvent(envelopeInput) {
  const envelope = parseEventEnvelope(envelopeInput);
  const className = classifyOcsf(envelope.type);
  return deepFreeze({
    class_name: className,
    activity_name: envelope.type,
    time: envelope.ts,
    severity: "Informational",
    metadata: {
      product: {
        name: "HoBo",
        feature: "event-export",
      },
      version: "ocsf-fixture/v1",
    },
    actor: {
      type: envelope.actor.kind,
      uid: envelope.actor.id,
    },
    observables: [
      { name: "tenant", value: envelope.tenant },
      { name: "streamId", value: envelope.streamId },
      { name: "seq", value: String(envelope.seq) },
    ],
    data: redactForAudit(envelope.data),
  });
}

export function toOtlpSpan(envelopeInput) {
  const envelope = parseEventEnvelope(envelopeInput);
  const traceparent = isJsonString(envelope.meta?.traceparent) ? envelope.meta.traceparent : "";
  const match = TRACEPARENT.exec(traceparent);
  return deepFreeze({
    traceId: match?.[1] ?? hashHex(`${envelope.tenant}:${envelope.correlationId ?? envelope.id}`).slice(0, 32),
    spanId: match?.[2] ?? hashHex(envelope.id).slice(0, 16),
    parentSpanId: envelope.causationId,
    name: envelope.type,
    kind: "INTERNAL",
    startTimeUnixNano: String(Date.parse(envelope.ts) * 1_000_000),
    attributes: {
      "hobo.event_type": envelope.type,
      "hobo.tenant": envelope.tenant,
      "hobo.stream_id": envelope.streamId,
      "hobo.seq": envelope.seq,
      "hobo.actor.kind": envelope.actor.kind,
      "hobo.actor.id": envelope.actor.id,
    },
  });
}

export function assertCoreApiSnapshot(snapshot) {
  const source = expectObject(snapshot, "API snapshot");
  const expected = JSON.stringify(CORE_API_SNAPSHOT.exports);
  const actual = JSON.stringify(source.exports);
  if (source.schemaVersion !== CORE_API_SNAPSHOT.schemaVersion || actual !== expected) {
    throw new Error("public API snapshot drift: update snapshot deliberately with a breaking-change note");
  }
  return deepFreeze(cloneJson(source));
}

export function validatePublicTypeSurface(declarationText) {
  const errors = [];
  const text = String(declarationText ?? "");
  if (PROVIDER_LEAK_PATTERN.test(text)) {
    errors.push("provider-specific symbol leak in @hobo/core public type surface");
  }
  for (const forbidden of ["accessKeyId", "secretAccessKey", "subscriptionId", "serviceAccountJson"]) {
    if (text.includes(forbidden)) {
      errors.push(`provider credential field leak: ${forbidden}`);
    }
  }
  for (const exported of CORE_API_SNAPSHOT.exports) {
    if (!text.includes(exported)) {
      errors.push(`missing public export declaration: ${exported}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function parseIndex(input, options) {
  const source = expectObject(input, "index.json");
  assertNoExtra(source, "index.json", ["schemaVersion", "issuer", "manifestDigest", "signature", "files"]);
  if (source.schemaVersion !== CORE_SCHEMA_VERSION) {
    throw new Error(`index.schemaVersion must be ${CORE_SCHEMA_VERSION}`);
  }
  const issuer = httpsUrl(source.issuer, "index.issuer");
  if (options.trustedIssuer && issuer !== httpsUrl(options.trustedIssuer, "trustedIssuer")) {
    throw new Error("index issuer does not match trusted issuer");
  }
  const files = uniqueStringArray(source.files, "index.files");
  for (const required of REQUIRED_MANIFEST_FILES) {
    if (!files.includes(required)) {
      throw new Error(`index.files must include ${required}`);
    }
  }
  const signature = expectObject(source.signature, "index.signature");
  assertNoExtra(signature, "index.signature", ["alg", "keyId", "digest"]);
  if (signature.alg !== "HOBO-FIXTURE-SHA256") {
    throw new Error("index.signature.alg must be HOBO-FIXTURE-SHA256");
  }
  return {
    schemaVersion: CORE_SCHEMA_VERSION,
    issuer,
    manifestDigest: sha256Ref(source.manifestDigest, "index.manifestDigest"),
    signature: {
      alg: "HOBO-FIXTURE-SHA256",
      keyId: nonEmptyString(signature.keyId, "index.signature.keyId"),
      digest: sha256Ref(signature.digest, "index.signature.digest"),
    },
    files,
  };
}

function parseCapabilities(input) {
  const source = expectObject(input, "capabilities.json");
  assertNoExtra(source, "capabilities.json", ["ports", "regions", "equivalenceClasses"]);
  const seenPorts = new Set();
  const ports = requiredArray(source.ports, "capabilities.ports").map((entry, index) => {
    const field = `capabilities.ports[${index}]`;
    const port = expectObject(entry, field);
    assertNoExtra(port, field, ["port", "kinds", "stability"]);
    const name = nonEmptyString(port.port, `${field}.port`);
    if (seenPorts.has(name)) {
      throw new Error(`duplicate capability port '${name}'`);
    }
    seenPorts.add(name);
    return {
      port: name,
      kinds: uniqueStringArray(port.kinds, `${field}.kinds`, { minLength: 1 }),
      stability: enumValue(port.stability, STABILITIES, `${field}.stability`),
    };
  });

  return {
    ports,
    regions: uniqueStringArray(source.regions, "capabilities.regions", { minLength: 1 }),
    equivalenceClasses: uniqueStringArray(source.equivalenceClasses ?? [], "capabilities.equivalenceClasses"),
  };
}

function parseAuth(input, index, options) {
  const source = expectObject(input, "auth.json");
  assertNoExtra(source, "auth.json", [
    "issuer",
    "flows",
    "scopeModel",
    "resourceIndicators",
    "tokenLifetimeSec",
    "audit",
  ]);
  const issuer = httpsUrl(source.issuer, "auth.issuer");
  if (issuer !== index.issuer) {
    throw new Error("auth.issuer must match index.issuer");
  }
  const flows = parseFlows(source.flows, options);
  const audit = expectObject(source.audit, "auth.audit");
  return {
    issuer,
    flows,
    scopeModel: enumValue(
      source.scopeModel,
      new Set(["least-privilege-per-resource"]),
      "auth.scopeModel",
    ),
    resourceIndicators: parseResourceIndicators(source.resourceIndicators),
    tokenLifetimeSec: positiveInteger(source.tokenLifetimeSec, "auth.tokenLifetimeSec", { max: 86_400 }),
    audit: {
      events: uniqueStringArray(audit.events, "auth.audit.events", { minLength: 1 }),
    },
  };
}

function parseFlows(input, options) {
  const flows = requiredArray(input, "auth.flows").map((flow, index) =>
    parseFlow(flow, index, options),
  );
  const seen = new Set();
  for (const flow of flows) {
    if (seen.has(flow.type)) {
      throw new Error(`duplicate auth flow type '${flow.type}'`);
    }
    seen.add(flow.type);
  }
  return flows.sort((a, b) => FLOW_ORDER.indexOf(a.type) - FLOW_ORDER.indexOf(b.type));
}

function parseFlow(input, index, options) {
  const source = expectObject(input, `auth.flows[${index}]`);
  const type = enumValue(source.type, FLOW_ORDER_SET, `auth.flows[${index}].type`);
  if (type === "oidc-federation") {
    assertNoExtra(source, `auth.flows[${index}]`, ["type", "audience", "exchange", "trust"]);
    const trust = expectObject(source.trust, `auth.flows[${index}].trust`);
    const oidcDiscovery = httpsUrl(trust.oidcDiscovery, `auth.flows[${index}].trust.oidcDiscovery`);
    if (options.trustedOidcDiscoveryHost && new URL(oidcDiscovery).hostname !== options.trustedOidcDiscoveryHost) {
      throw new Error("auth oidcDiscovery host does not match trusted host");
    }
    return {
      type,
      audience: nonEmptyString(source.audience, `auth.flows[${index}].audience`),
      exchange: nonEmptyString(source.exchange, `auth.flows[${index}].exchange`),
      trust: { oidcDiscovery },
    };
  }
  if (type === "api-key") {
    assertNoExtra(source, `auth.flows[${index}]`, ["type", "header", "rotation"]);
    return {
      type,
      header: headerName(source.header, "api-key header"),
      rotation: enumValue(source.rotation, new Set(["manual"]), `auth.flows[${index}].rotation`),
    };
  }
  if (type === "device-code") {
    assertNoExtra(source, `auth.flows[${index}]`, ["type", "authorizationServer"]);
    return source.authorizationServer === undefined
      ? { type }
      : { type, authorizationServer: httpsUrl(source.authorizationServer, `auth.flows[${index}].authorizationServer`) };
  }
  assertNoExtra(source, `auth.flows[${index}]`, ["type", "authorizationServer", "audience", "scopes", "idJag"]);
  return {
    type,
    authorizationServer: httpsUrl(source.authorizationServer, `auth.flows[${index}].authorizationServer`),
    ...(source.audience === undefined ? undefined : { audience: nonEmptyString(source.audience, `auth.flows[${index}].audience`) }),
    scopes: uniqueStringArray(source.scopes, `auth.flows[${index}].scopes`, { minLength: 1 }),
    ...(source.idJag === undefined ? undefined : { idJag: source.idJag === true }),
  };
}

function parseCost(input) {
  const source = expectObject(input, "cost.json");
  assertNoExtra(source, "cost.json", ["currency", "unitPrices", "freeTier"]);
  const unitPrices = expectObject(source.unitPrices, "cost.unitPrices");
  if (Object.keys(unitPrices).length === 0) {
    throw new Error("cost.unitPrices must not be empty");
  }
  for (const [name, price] of Object.entries(unitPrices)) {
    const entry = expectObject(price, `cost.unitPrices.${name}`);
    if (!Number.isFinite(entry.amount) || entry.amount <= 0) {
      throw new Error(`cost.unitPrices.${name}.amount must be positive`);
    }
  }
  return {
    currency: currency(source.currency, "cost.currency"),
    unitPrices: cloneJson(unitPrices),
    freeTier: source.freeTier === undefined ? [] : cloneJson(requiredArray(source.freeTier, "cost.freeTier")),
  };
}

function parsePrincipal(input, field) {
  const source = expectObject(input, field);
  const principal = {
    kind: enumValue(source.kind, PRINCIPAL_KINDS, `${field}.kind`),
    id: nonEmptyString(source.id, `${field}.id`),
  };
  if (source.delegatedBy !== undefined) {
    principal.delegatedBy = parsePrincipal(source.delegatedBy, `${field}.delegatedBy`);
  }
  return principal;
}

function parseResourceIndicators(input) {
  return uniqueStringArray(input, "auth.resourceIndicators", { minLength: 1 }).map((indicator) => {
    if (indicator.startsWith("urn:")) {
      const parts = indicator.split(":");
      if (parts.length < 3 || parts.some((part) => part === "")) {
        throw new Error(`resource indicator '${indicator}' must be urn:<namespace>:<resource>`);
      }
      return indicator;
    }
    httpsUrl(indicator, "auth.resourceIndicators");
    return indicator;
  });
}

function classifyOcsf(type) {
  if (type.startsWith("identity.") || type.startsWith("token.") || type.startsWith("session.")) {
    return "Authentication";
  }
  if (type.startsWith("policy.")) {
    return "Authorization";
  }
  return "Application Activity";
}

function redactForAudit(input) {
  if (Array.isArray(input)) {
    return input.map((item) => redactForAudit(item));
  }
  if (!input || !isJsonObject(input)) {
    return input;
  }
  const redacted = {};
  for (const [key, value] of Object.entries(input)) {
    if (/token|secret|svid|jwt|password|value/i.test(key)) {
      continue;
    }
    redacted[key] = redactForAudit(value);
  }
  return redacted;
}

function portKey(descriptor) {
  return `${descriptor.kind}:${descriptor.interface}:${descriptor.name}`;
}

function parseInterfaceRef(value, field) {
  const ref = nonEmptyString(value, field);
  if (!/^[a-z][a-z0-9-]*:[a-z0-9-]+\/[a-z0-9-]+(?:@[0-9]+\.[0-9]+\.[0-9]+)?$/.test(ref)) {
    throw new Error(`${field} must be a WIT-style interface ref`);
  }
  return ref;
}

function expectObject(value, field) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function assertNoExtra(value, field, allowed) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(expectObject(value, field))) {
    if (!allowedSet.has(key)) {
      throw new Error(`${field} has unexpected property '${key}'`);
    }
  }
}

function requiredArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }
  return value;
}

function uniqueStringArray(value, field, options = {}) {
  const array = options.minLength ? requiredArray(value, field) : Array.isArray(value) ? value : [];
  const seen = new Set();
  return array.map((entry, index) => {
    const normalized = nonEmptyString(entry, `${field}[${index}]`);
    if (seen.has(normalized)) {
      throw new Error(`${field} has duplicate '${normalized}'`);
    }
    seen.add(normalized);
    return normalized;
  });
}

function enumValue(value, allowed, field) {
  if (!allowed.has(value)) {
    throw new Error(`${field} must be one of ${[...allowed].join(", ")}`);
  }
  return value;
}

function nonEmptyString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function sha256Ref(value, field) {
  const ref = nonEmptyString(value, field);
  if (!SHA256_REF.test(ref)) {
    throw new Error(`${field} must be sha256:<64 hex chars>`);
  }
  return ref;
}

function httpsUrl(value, field) {
  const url = nonEmptyString(value, field);
  if (!HTTPS_URL.test(url)) {
    throw new Error(`${field} must be an https URL`);
  }
  return url;
}

function headerName(value, field) {
  const header = nonEmptyString(value, field);
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(header)) {
    throw new Error(`${field} must be an HTTP header name`);
  }
  return header;
}

function currency(value, field) {
  const code = nonEmptyString(value, field);
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(`${field} must be ISO-4217-style uppercase currency`);
  }
  return code;
}

function positiveInteger(value, field, options = {}) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${field} must be <= ${options.max}`);
  }
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function isoTimestamp(value, field) {
  const timestamp = nonEmptyString(value, field);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function canonicalJsonObject(value, field) {
  const source = expectObject(value, field);
  return cloneJson(source);
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function hashHex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function deepFreeze(value) {
  if (value && isJsonObject(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}
