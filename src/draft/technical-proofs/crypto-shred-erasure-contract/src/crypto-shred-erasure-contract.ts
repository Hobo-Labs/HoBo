import { isJsonObject } from "./json.js";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export const TOMBSTONE = "[crypto-shredded]";

export class AppendOnlyLogViolationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AppendOnlyLogViolationError";
    this.details = details;
  }
}

export class ForgettableInvariantError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ForgettableInvariantError";
    this.details = details;
  }
}

export function createEventLog() {
  return { events: [], nextSeq: 1 };
}

export function createKeyring() {
  return {
    erasureEpoch: 0,
    subjects: new Map(),
    tenants: new Map(),
  };
}

export function provisionTenant(keyring, tenantId) {
  if (keyring.tenants.has(tenantId)) {
    return keyring.tenants.get(tenantId);
  }

  const tenant = {
    destroyedAtEpoch: null,
    key: randomBytes(32),
    keyId: `tenant/${tenantId}/v1`,
    tenantId,
  };
  keyring.tenants.set(tenantId, tenant);
  return tenant;
}

export function provisionSubject(keyring, { tenantId, subjectId }) {
  provisionTenant(keyring, tenantId);
  const id = subjectKeyId({ tenantId, subjectId });
  if (keyring.subjects.has(id)) {
    return keyring.subjects.get(id);
  }

  const subject = {
    destroyedAtEpoch: null,
    key: randomBytes(32),
    keyId: `${id}/v1`,
    subjectId,
    tenantId,
  };
  keyring.subjects.set(id, subject);
  return subject;
}

export function appendRegisteredCustomer(log, keyring, { tenantId, subjectId, email, name }) {
  return appendEvent(log, {
    data: {
      email: encryptForgettableField(keyring, {
        field: "email",
        plaintext: email,
        subjectId,
        tenantId,
      }),
      name,
      subjectId,
      tenantId,
    },
    streamId: `tenant/${tenantId}/customer/${subjectId}`,
    type: "customer.Registered",
  });
}

export function appendNotificationSent(log, keyring, { tenantId, subjectId, recipient, template }) {
  return appendEvent(log, {
    data: {
      recipient: encryptForgettableField(keyring, {
        field: "recipient",
        plaintext: recipient,
        subjectId,
        tenantId,
      }),
      subjectId,
      template,
      tenantId,
    },
    streamId: `tenant/${tenantId}/notification/${subjectId}`,
    type: "notification.Sent",
  });
}

export function cryptoShredSubject(log, keyring, { tenantId, subjectId, reason }) {
  appendEvent(log, {
    data: { reason, subjectId, tenantId },
    streamId: `tenant/${tenantId}/erasure/${subjectId}`,
    type: "erasure.Requested",
  });

  destroySubjectKey(keyring, { tenantId, subjectId });

  return appendEvent(log, {
    data: {
      result: "key-destroyed",
      subjectId,
      tenantId,
      tombstone: TOMBSTONE,
    },
    streamId: `tenant/${tenantId}/erasure/${subjectId}`,
    type: "erasure.Completed",
  });
}

export function cryptoShredTenant(log, keyring, { tenantId, reason }) {
  const tenant = requireTenant(keyring, tenantId);
  keyring.erasureEpoch += 1;
  tenant.destroyedAtEpoch = keyring.erasureEpoch;
  tenant.key = null;

  return appendEvent(log, {
    data: {
      reason,
      result: "tenant-key-destroyed",
      tenantId,
      tombstone: TOMBSTONE,
    },
    streamId: `tenant/${tenantId}/lifecycle`,
    type: "tenant.Erased",
  });
}

export function rebuildProjection(events, keyring) {
  const erasedSubjects = new Set();
  const erasedTenants = new Set();
  const decryptedRecords = new Map();
  const notificationTrail = [];

  for (const event of canonicalEvents(events)) {
    if (event.type === "erasure.Completed") {
      erasedSubjects.add(subjectKeyId(event.data));
      continue;
    }

    if (event.type === "tenant.Erased") {
      erasedTenants.add(event.data.tenantId);
      continue;
    }

    if (event.type === "customer.Registered") {
      const key = subjectKeyId(event.data);
      const email = decryptForgettableField(keyring, event.data.email);
      decryptedRecords.set(key, {
        email,
        name: event.data.name,
        subjectId: event.data.subjectId,
        tenantId: event.data.tenantId,
      });
      continue;
    }

    if (event.type === "notification.Sent") {
      notificationTrail.push({
        recipient: decryptForgettableField(keyring, event.data.recipient),
        subjectId: event.data.subjectId,
        template: event.data.template,
        tenantId: event.data.tenantId,
      });
    }
  }

  const customers = {};
  for (const [key, record] of [...decryptedRecords.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (erasedSubjects.has(key) || erasedTenants.has(record.tenantId)) {
      continue;
    }
    customers[key] = record;
  }

  return {
    customers,
    decryptedRecords: Object.fromEntries([...decryptedRecords.entries()].sort(([left], [right]) => left.localeCompare(right))),
    erasedSubjects: [...erasedSubjects].sort(),
    erasedTenants: [...erasedTenants].sort(),
    eventStructureDigest: digestEventStructure(events),
    notificationTrail,
  };
}

export function createSnapshot({ events, keyring }) {
  const projection = rebuildProjection(events, keyring);
  return {
    eventStructureDigest: projection.eventStructureDigest,
    erasureEpoch: keyring.erasureEpoch,
    state: projection,
    throughSeq: highestSeq(events),
  };
}

export function activateSnapshot({ events, keyring, snapshot }) {
  if (
    snapshot.erasureEpoch !== keyring.erasureEpoch ||
    snapshot.eventStructureDigest !== digestEventStructure(events.filter((event) => event.seq <= snapshot.throughSeq))
  ) {
    return {
      ignoredSnapshotReason: "erasure-epoch-changed",
      state: rebuildProjection(events, keyring),
      usedSnapshot: false,
    };
  }

  return {
    ignoredSnapshotReason: null,
    state: snapshot.state,
    usedSnapshot: true,
  };
}

export function assertNoForgettableWriteInvariants(schema) {
  const violations = findForgettableWriteInvariantViolations(schema);
  if (violations.length > 0) {
    throw new ForgettableInvariantError("write-side aggregate invariant references a forgettable field", {
      violations,
    });
  }
  return { checked: true, violations };
}

export function findForgettableWriteInvariantViolations(schema) {
  const forgettableFields = new Set(
    Object.entries(schema.fields )
      .filter(([, field]) => field.forgettable)
      .map(([fieldName]) => fieldName),
  );

  return (schema.invariants ?? [])
    .filter((invariant) => invariant.writeSide)
    .flatMap((invariant) =>
      (invariant.fields ?? [])
        .filter((field) => forgettableFields.has(field))
        .map((field) => ({
          code: "FORGETTABLE_WRITE_INVARIANT",
          field,
          invariant: invariant.name,
          message: `write-side invariant ${invariant.name} cannot depend on forgettable field ${field}`,
        })),
    );
}

export function assertOriginalEventsUnchanged(beforeEvents, afterEvents) {
  const afterPrefix = afterEvents.slice(0, beforeEvents.length);
  if (canonicalJson(beforeEvents) !== canonicalJson(afterPrefix)) {
    throw new AppendOnlyLogViolationError("previous log events were rewritten during erasure");
  }
  return true;
}

export function attemptDeleteForErasure(log, predicate) {
  const matchingSeqs = log.events.filter(predicate).map((event) => event.seq);
  throw new AppendOnlyLogViolationError("erasure must append tombstones, not delete log events", {
    matchingSeqs,
  });
}

export function digestEventStructure(events) {
  return sha256(canonicalEvents(events).map((event) => ({
    id: event.id,
    seq: event.seq,
    streamId: event.streamId,
    type: event.type,
  })));
}

function appendEvent(log, event) {
  const next = Object.freeze({
    ...clone(event),
    id: event.id ?? `evt-${log.nextSeq}`,
    seq: log.nextSeq,
  });
  log.events.push(next);
  log.nextSeq += 1;
  return next;
}

function encryptForgettableField(keyring, { tenantId, subjectId, field, plaintext }) {
  const subject = provisionSubject(keyring, { tenantId, subjectId });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", subject.key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Object.freeze({
    ciphertext: ciphertext.toString("base64"),
    field,
    iv: iv.toString("base64"),
    keyId: subject.keyId,
    subjectId,
    tag: tag.toString("base64"),
    tenantId,
  });
}

function decryptForgettableField(keyring, encrypted) {
  const subject = keyring.subjects.get(subjectKeyId(encrypted));
  const tenant = keyring.tenants.get(encrypted.tenantId);
  if (!subject?.key || subject.destroyedAtEpoch !== null || !tenant?.key || tenant.destroyedAtEpoch !== null) {
    return TOMBSTONE;
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    subject.key,
    Buffer.from(encrypted.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function destroySubjectKey(keyring, { tenantId, subjectId }) {
  const subject = requireSubject(keyring, { tenantId, subjectId });
  keyring.erasureEpoch += 1;
  subject.destroyedAtEpoch = keyring.erasureEpoch;
  subject.key = null;
}

function requireTenant(keyring, tenantId) {
  const tenant = keyring.tenants.get(tenantId);
  if (!tenant) {
    throw new Error(`unknown tenant ${tenantId}`);
  }
  return tenant;
}

function requireSubject(keyring, { tenantId, subjectId }) {
  const subject = keyring.subjects.get(subjectKeyId({ tenantId, subjectId }));
  if (!subject) {
    throw new Error(`unknown subject ${tenantId}/${subjectId}`);
  }
  return subject;
}

function subjectKeyId({ tenantId, subjectId }) {
  return `tenant/${tenantId}/subject/${subjectId}`;
}

function canonicalEvents(events) {
  return [...events].sort((left, right) => (
    left.seq - right.seq ||
    left.streamId.localeCompare(right.streamId) ||
    left.type.localeCompare(right.type) ||
    String(left.id).localeCompare(String(right.id))
  ));
}

function highestSeq(events) {
  return events.reduce((highest, event) => Math.max(highest, event.seq), 0);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }

  return value;
}

function clone(value) {
  return structuredClone(value);
}
