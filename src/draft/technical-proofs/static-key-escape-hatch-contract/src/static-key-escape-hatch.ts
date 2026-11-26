import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


const DEFAULT_MAX_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const REDACTED = "[secret:redacted]";

export class StaticKeyExpiredError extends Error {
  constructor(keyRef, expiresAt) {
    super(`static key ${keyRef} expired at ${expiresAt}`);
    this.name = "StaticKeyExpiredError";
    this.keyRef = keyRef;
    this.expiresAt = expiresAt;
  }
}

export class StaticKeyRotationOverdueError extends Error {
  constructor(keyRef, rotationDueAt) {
    super(`static key ${keyRef} rotation is overdue since ${rotationDueAt}`);
    this.name = "StaticKeyRotationOverdueError";
    this.keyRef = keyRef;
    this.rotationDueAt = rotationDueAt;
  }
}

export class StaticKeyOptInRequiredError extends Error {
  constructor(keyRef) {
    super(`static key ${keyRef} explicit opt-in is required`);
    this.name = "StaticKeyOptInRequiredError";
    this.keyRef = keyRef;
  }
}

export function createStaticKeyEscapeHatch({
  now = () => new Date(),
  envelopeStore,
  eventSink = () => {},
  idFactory = defaultIdFactory(),
  maxTtlDays = DEFAULT_MAX_TTL_DAYS,
} = {}) {
  if (!envelopeStore || !(envelopeStore.decrypt instanceof Function)) {
    throw new Error("envelopeStore.decrypt is required");
  }
  if (!Number.isFinite(maxTtlDays) || maxTtlDays <= 0 || maxTtlDays > DEFAULT_MAX_TTL_DAYS) {
    throw new Error(`max TTL must be configurable down from P${DEFAULT_MAX_TTL_DAYS}D`);
  }

  const records = new Map();
  let seq = 0;

  return {
    register(record) {
      const normalized = normalizeRecord(record, maxTtlDays);
      records.set(normalized.keyRef, normalized);
      return clone(normalized);
    },

    async fetch(keyRef, request = {}) {
      const record = records.get(keyRef);
      if (!record) {
        throw new Error(`static key ${keyRef} is not registered`);
      }

      const currentTime = nowDate(now);
      assertUsable(record, currentTime);
      assertExplicitOptIn(keyRef, request.optIn, currentTime);

      const plaintext = await envelopeStore.decrypt(record.envelope, {
        keyRef,
        provider: record.provider,
        subject: request.subject,
        optIn: request.optIn,
      });
      const usageId = idFactory("use-static-key");
      const grantId = idFactory("grant-static-key");
      const common = {
        actor: request.subject ?? { kind: "service", id: "yard/identity" },
        time: currentTime.toISOString(),
        seq,
        correlationId: request.correlationId ?? `corr-${usageId}`,
        causationId: request.causationId ?? `cmd-${usageId}`,
      };

      emit("token.Granted", {
        grantId,
        subject: request.subject ?? { kind: "service", id: "yard/identity" },
        target: { kind: "provider", id: record.provider },
        audience: record.audience,
        scopes: record.scopes,
        tokenRef: `${record.keyRef}#static-hatch-grant`,
        expiresAt: record.expiresAt,
      }, common);
      emit("token.Used", {
        grantId,
        usageId,
        operation: request.operation ?? "secret.read",
        resource: request.resource ?? record.keyRef,
      }, common);
      emit("secret.Accessed", {
        secretRef: record.keyRef,
        source: "static-secret-hatch",
        tokenUsageId: usageId,
        envelopeRef: record.envelope.ciphertextRef,
        redaction: "value-redacted",
        optInReason: request.optIn.reason,
      }, common);

      return {
        kind: "static-secret-value",
        source: "static-secret-hatch",
        provider: record.provider,
        keyRef: record.keyRef,
        value: new SecretValue(plaintext),
        audit: { grantId, usageId },
        record: {
          expiresAt: record.expiresAt,
          rotation: {
            dueAt: record.rotationDueAt,
            previousKeyRef: record.previousKeyRef,
          },
        },
      };
    },

    persistableView() {
      return {
        kind: "static-key-escape-hatch-store",
        defaultMaxTtl: `P${DEFAULT_MAX_TTL_DAYS}D`,
        configuredMaxTtl: `P${maxTtlDays}D`,
        keys: Object.fromEntries([...records].map(([keyRef, record]) => [keyRef, clone(record)])),
      };
    },
  };

  function emit(type, data, common) {
    const event = createIdentityEvent(type, data, {
      ...common,
      id: idFactory(`evt-${type.toLowerCase().replaceAll(".", "-")}`),
      seq: ++seq,
    });
    const validation = validateIdentityEvent(event);
    if (!validation.ok) {
      throw new Error(validation.errors.join("; "));
    }
    eventSink(event);
    return event;
  }
}

export function createFixtureEnvelopeStore(entries = {}) {
  const store = entries instanceof Map ? entries : new Map(Object.entries(entries));
  return {
    async decrypt(envelope) {
      requireEnvelope(envelope);
      if (!store.has(envelope.ciphertextRef)) {
        throw new Error(`missing ciphertext fixture ${envelope.ciphertextRef}`);
      }
      return store.get(envelope.ciphertextRef);
    },
  };
}

export function assertStaticKeyNoPlaintextConformance(surfaces, secrets) {
  for (const [name, value] of Object.entries(surfaces ?? {})) {
    const serialized = JSON.stringify(value ?? null);
    for (const secret of secrets) {
      if (isJsonString(secret) && secret.length > 0 && serialized.includes(secret)) {
        throw new Error(`${name} contains plaintext static key`);
      }
    }
  }
}

class SecretValue {
  #plaintext;

  constructor(plaintext) {
    if (!isJsonString(plaintext) || plaintext.length === 0) {
      throw new Error("decrypted static key material must be a non-empty string");
    }
    this.#plaintext = plaintext;
    Object.freeze(this);
  }

  reveal() {
    return this.#plaintext;
  }

  toString() {
    return REDACTED;
  }

  toJSON() {
    return REDACTED;
  }
}

function normalizeRecord(record, configuredMaxTtlDays) {
  if (!isPlainObject(record)) {
    throw new Error("static key record must be an object");
  }
  if ("value" in record || "plaintext" in record || "secret" in record || "apiKey" in record) {
    throw new Error("plaintext static key material is forbidden");
  }
  requireString(record.keyRef, "keyRef");
  requireString(record.provider, "provider");
  requireString(record.audience, "audience");
  if (!Array.isArray(record.scopes) || record.scopes.length === 0) {
    throw new Error("scopes must be a non-empty array");
  }
  record.scopes.forEach((scope, index) => requireString(scope, `scopes[${index}]`));
  requireEnvelope(record.envelope);

  const issuedAt = parseIso(record.issuedAt, "issuedAt");
  const expiresAt = parseIso(record.expiresAt, "expiresAt");
  if (expiresAt <= issuedAt) {
    throw new Error("expiresAt must be after issuedAt");
  }

  const recordMaxTtlDays = record.maxTtlDays ?? configuredMaxTtlDays;
  if (!Number.isFinite(recordMaxTtlDays) || recordMaxTtlDays <= 0 || recordMaxTtlDays > configuredMaxTtlDays) {
    throw new Error(`record max TTL exceeds configured P${configuredMaxTtlDays}D`);
  }
  if (expiresAt.getTime() - issuedAt.getTime() > recordMaxTtlDays * DAY_MS) {
    throw new Error(`static key ${record.keyRef} exceeds max TTL P${recordMaxTtlDays}D`);
  }

  const normalized = {
    keyRef: record.keyRef,
    provider: record.provider,
    audience: record.audience,
    scopes: [...record.scopes].sort(),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    rotationDueAt: parseOptionalIso(record.rotationDueAt, "rotationDueAt")?.toISOString(),
    previousKeyRef: record.previousKeyRef,
    envelope: {
      ciphertextRef: record.envelope.ciphertextRef,
      dekRef: record.envelope.dekRef,
      kekRef: record.envelope.kekRef,
    },
  };
  return deepFreeze(stripUndefined(normalized));
}

function assertUsable(record, currentTime) {
  if (parseIso(record.expiresAt, "expiresAt") <= currentTime) {
    throw new StaticKeyExpiredError(record.keyRef, record.expiresAt);
  }
  if (record.rotationDueAt && parseIso(record.rotationDueAt, "rotationDueAt") <= currentTime) {
    throw new StaticKeyRotationOverdueError(record.keyRef, record.rotationDueAt);
  }
}

function assertExplicitOptIn(keyRef, optIn, currentTime) {
  if (!isPlainObject(optIn)) {
    throw new StaticKeyOptInRequiredError(keyRef);
  }
  if (!isPlainObject(optIn.approvedBy) || !optIn.approvedBy.kind || !optIn.approvedBy.id) {
    throw new StaticKeyOptInRequiredError(keyRef);
  }
  if (!isJsonString(optIn.reason) || optIn.reason.trim().length === 0) {
    throw new StaticKeyOptInRequiredError(keyRef);
  }
  if (optIn.expiresAt && parseIso(optIn.expiresAt, "optIn.expiresAt") <= currentTime) {
    throw new StaticKeyOptInRequiredError(keyRef);
  }
}

function requireEnvelope(envelope) {
  if (!isPlainObject(envelope)) {
    throw new Error("envelope is required");
  }
  requireString(envelope.ciphertextRef, "envelope.ciphertextRef");
  requireString(envelope.dekRef, "envelope.dekRef");
  requireString(envelope.kekRef, "envelope.kekRef");
}

function parseOptionalIso(value, path) {
  return value === undefined ? undefined : parseIso(value, path);
}

function parseIso(value, path) {
  requireString(value, path);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${path} must be ISO-8601`);
  }
  return parsed;
}

function requireString(value, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${path} is required`);
  }
}

function nowDate(now) {
  const value = now();
  return value instanceof Date ? value : new Date(value);
}

function defaultIdFactory() {
  let seq = 0;
  return (prefix) => `${prefix}-${++seq}`;
}

function isPlainObject(value) {
  return (
    value !== null &&
    isJsonObject(value) &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
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
