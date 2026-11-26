import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


const DEFAULT_MAX_VALIDATE_TO_PROMOTE_MS = 60_000;
const MINIMUM_VANTAGE_POINTS = 3;

export function validateAndPinDnsEvidence(change, evidence, options = {}) {
  const normalizedChange = normalizeChange(change);
  const normalizedEvidence = normalizeEvidence(evidence);
  const nowMs = normalizeMs(options.nowMs ?? 0, "nowMs");
  const maxValidateToPromoteMs = normalizeMs(
    options.maxValidateToPromoteMs ?? DEFAULT_MAX_VALIDATE_TO_PROMOTE_MS,
    "maxValidateToPromoteMs",
  );
  const events = [
    domainEvent("domain.ValidationStarted", {
      changeId: normalizedChange.changeId,
      domain: normalizedChange.domain,
      fqdn: normalizedChange.fqdn,
      liveZoneMutationAllowed: false,
      tsMs: nowMs,
    }),
  ];
  const checks = [];

  for (const [kind, evaluate] of [
    ["multi-vantage-resolve", evaluateMultiVantage],
    ["ttl-aware-propagation", evaluateTtl],
    ["acme-challenge", evaluateAcme],
    ["endpoint-health", evaluateHealth],
  ]) {
    const failure = evaluate(normalizedChange, normalizedEvidence);
    if (failure) {
      return failed(events, normalizedChange, {
        failedCheck: kind,
        reason: failure,
        checks,
        nowMs,
      });
    }
    checks.push({ kind, status: "passed" });
  }

  const evidenceDigest = digestDnsEvidence(normalizedChange, normalizedEvidence);
  const liveZoneDigest = options.liveZone
    ? digestLiveZone(options.liveZone, normalizedChange.domain)
    : digestLiveRecords([]);

  events.push(
    domainEvent("domain.Validated", {
      changeId: normalizedChange.changeId,
      domain: normalizedChange.domain,
      fqdn: normalizedChange.fqdn,
      evidenceDigest,
      liveZoneDigest,
      liveZoneUntouched: true,
      checks,
      tsMs: nowMs,
    }),
  );

  return deepFreeze({
    status: "validated",
    change: normalizedChange,
    evidenceDigest,
    liveZoneDigest,
    validatedAtMs: nowMs,
    maxValidateToPromoteMs,
    events,
    checks,
  });
}

export function promotePinnedDnsChange(validation, options = {}) {
  if (!validation || validation.status !== "validated") {
    return promotionFailure(null, {
      failedCheck: "promote-recheck",
      reason: "promotion requires a validated pinned evidence result",
      nowMs: normalizeMs(options.nowMs ?? 0, "nowMs"),
    });
  }

  const nowMs = normalizeMs(options.nowMs ?? validation.validatedAtMs, "nowMs");
  const maxValidateToPromoteMs = normalizeMs(
    options.maxValidateToPromoteMs ?? validation.maxValidateToPromoteMs ?? DEFAULT_MAX_VALIDATE_TO_PROMOTE_MS,
    "maxValidateToPromoteMs",
  );
  const normalizedEvidence = normalizeEvidence(options.currentEvidence);
  const currentDigest = digestDnsEvidence(validation.change, normalizedEvidence);
  if (currentDigest !== validation.evidenceDigest) {
    return promotionFailure(validation, {
      failedCheck: "promote-recheck",
      reason: `pinned validation evidence changed before promote: ${validation.evidenceDigest} != ${currentDigest}`,
      nowMs,
      currentDigest,
    });
  }

  const rechecked = validateAndPinDnsEvidence(validation.change, normalizedEvidence, {
    nowMs: validation.validatedAtMs,
    maxValidateToPromoteMs,
  });
  if (rechecked.status !== "validated") {
    return promotionFailure(validation, {
      failedCheck: rechecked.failedCheck,
      reason: rechecked.reason,
      nowMs,
      currentDigest,
    });
  }

  const windowMs = nowMs - validation.validatedAtMs;
  if (windowMs < 0 || windowMs > maxValidateToPromoteMs) {
    return promotionFailure(validation, {
      failedCheck: "promote-recheck",
      reason: `validate-to-promote window ${windowMs}ms exceeds bound ${maxValidateToPromoteMs}ms`,
      nowMs,
      currentDigest,
    });
  }

  const liveZone = requireLiveZone(options.liveZone);
  const currentLiveZoneDigest = digestLiveZone(liveZone, validation.change.domain);
  if (currentLiveZoneDigest !== validation.liveZoneDigest) {
    return promotionFailure(validation, {
      failedCheck: "live-zone-invariant",
      reason: "live zone changed before promote recheck completed",
      nowMs,
      currentDigest,
      currentLiveZoneDigest,
    });
  }

  liveZone.write(validation.change.domain, validation.change.record);
  const event = domainEvent("domain.RoutingChanged", {
    changeId: validation.change.changeId,
    domain: validation.change.domain,
    fqdn: validation.change.fqdn,
    record: clone(validation.change.record),
    evidenceDigest: validation.evidenceDigest,
    tsMs: nowMs,
  });

  return deepFreeze({
    status: "promoted",
    evidenceDigest: validation.evidenceDigest,
    events: [...validation.events, event],
    record: clone(validation.change.record),
  });
}

export function createRecordingLiveZone(initial = {}) {
  const zones = new Map();
  const writeLog = [];
  for (const [domain, records] of Object.entries(initial)) {
    for (const record of records) {
      upsert(zones, domain, normalizeRecord(record));
    }
  }

  return Object.freeze({
    write(domain, record) {
      const normalizedDomain = requireDomain(domain, "domain");
      const normalizedRecord = normalizeRecord(record);
      upsert(zones, normalizedDomain, normalizedRecord);
      writeLog.push({ domain: normalizedDomain, record: clone(normalizedRecord) });
    },

    inspect(domain) {
      return recordsFor(zones, requireDomain(domain, "domain"));
    },

    writes() {
      return clone(writeLog);
    },
  });
}

function digestDnsEvidence(change, evidence) {
  return `sha256:${createHash("sha256")
    .update(canonicalJson({ change: normalizeChange(change), evidence: normalizeEvidence(evidence) }))
    .digest("hex")}`;
}

function evaluateMultiVantage(change, evidence) {
  const answers = evidence.resolutions;
  if (answers.length < MINIMUM_VANTAGE_POINTS) {
    return `multi-vantage resolution requires at least ${MINIMUM_VANTAGE_POINTS} independent vantages`;
  }
  const seen = new Set();
  for (const answer of answers) {
    if (seen.has(answer.vantage)) {
      return `duplicate vantage ${answer.vantage}`;
    }
    seen.add(answer.vantage);
    if (!arraysEqual(answer.targets, change.expectedTargets)) {
      return `${answer.vantage} resolved ${answer.targets.join(", ") || "<empty>"} instead of ${change.expectedTargets.join(", ")}`;
    }
  }
  const serials = new Set(answers.map((answer) => answer.serial));
  if (serials.size !== 1) {
    return "resolver evidence is not stable across vantage serials";
  }
  return null;
}

function evaluateTtl(_change, evidence) {
  const ttl = evidence.ttl;
  const requiredWindowMs = ttl.previousTtlMs + ttl.candidateTtlMs;
  if (ttl.waitedMs < requiredWindowMs) {
    return `TTL propagation waited ${ttl.waitedMs}ms, below previous+candidate TTL window ${requiredWindowMs}ms`;
  }
  if (ttl.stableSerialAcrossVantages !== true) {
    return "TTL propagation did not prove a stable serial across vantages";
  }
  return null;
}

function evaluateAcme(change, evidence) {
  const acme = evidence.acme;
  const expectedChallengeName = `_acme-challenge.${change.fqdn}`;
  if (acme.fqdn !== change.fqdn) {
    return `ACME evidence fqdn ${acme.fqdn} does not match ${change.fqdn}`;
  }
  if (acme.challengeName !== expectedChallengeName) {
    return `ACME challenge must be ${expectedChallengeName}`;
  }
  if (
    acme.keyThumbprint !== change.expectedAcmeKeyThumbprint ||
    acme.expectedKeyThumbprint !== change.expectedAcmeKeyThumbprint
  ) {
    return "ACME key thumbprint does not match the pinned domain key";
  }
  if (
    acme.csrIdentifier !== change.expectedCsrIdentifier ||
    acme.expectedCsrIdentifier !== change.expectedCsrIdentifier
  ) {
    return "ACME CSR identifier does not match the domain intent";
  }
  return null;
}

function evaluateHealth(change, evidence) {
  const health = evidence.health;
  if (health.probedHost !== change.fqdn || health.candidateHost !== change.fqdn) {
    return `health probe must use candidate host ${change.fqdn}`;
  }
  if (
    health.gatewayIdentity !== change.expectedGatewayIdentity ||
    health.expectedGatewayIdentity !== change.expectedGatewayIdentity
  ) {
    return "health probe gateway identity mismatch";
  }
  if (!Number.isInteger(health.status) || health.status < 200 || health.status >= 400) {
    return "health status must be 2xx/3xx";
  }
  return null;
}

function failed(events, change, { failedCheck, reason, checks, nowMs }) {
  events.push(
    domainEvent("domain.ValidationFailed", {
      changeId: change.changeId,
      domain: change.domain,
      fqdn: change.fqdn,
      failedCheck,
      reason,
      liveZoneUntouched: true,
      checks,
      tsMs: nowMs,
    }),
  );

  return deepFreeze({
    status: "failed",
    failedCheck,
    reason,
    events,
    checks,
  });
}

function promotionFailure(validation, { failedCheck, reason, nowMs, currentDigest, currentLiveZoneDigest }) {
  const change = validation?.change ?? {};
  const event = domainEvent("domain.ValidationFailed", {
    changeId: change.changeId ?? null,
    domain: change.domain ?? null,
    fqdn: change.fqdn ?? null,
    failedCheck,
    reason,
    currentDigest: currentDigest ?? null,
    currentLiveZoneDigest: currentLiveZoneDigest ?? null,
    liveZoneUntouched: failedCheck !== "live-zone-invariant",
    tsMs: nowMs,
  });

  return deepFreeze({
    status: "blocked",
    failedCheck,
    reason,
    events: validation?.events ? [...validation.events, event] : [event],
  });
}

function normalizeChange(change) {
  if (!change || !isJsonObject(change) || Array.isArray(change)) {
    throw new Error("domain change is required");
  }
  const domain = requireDomain(change.domain, "domain");
  const fqdn = requireDomain(change.fqdn, "fqdn");
  if (fqdn !== domain && !fqdn.endsWith(`.${domain}`)) {
    throw new Error(`fqdn ${fqdn} must be inside domain ${domain}`);
  }
  const record = normalizeRecord(change.record);
  if (record.name !== fqdn) {
    throw new Error(`record ${record.name} must match fqdn ${fqdn}`);
  }

  const expectedTargets = normalizeTargets(
    change.expectedTargets ?? record.targets.map((target) => target.value),
    "expectedTargets",
  );
  return {
    changeId: requireString(change.changeId, "changeId"),
    domain,
    fqdn,
    record,
    expectedTargets,
    expectedGatewayIdentity: requireString(change.expectedGatewayIdentity, "expectedGatewayIdentity"),
    expectedAcmeKeyThumbprint: requireString(change.expectedAcmeKeyThumbprint, "expectedAcmeKeyThumbprint"),
    expectedCsrIdentifier: requireString(change.expectedCsrIdentifier, "expectedCsrIdentifier"),
  };
}

function normalizeEvidence(evidence) {
  if (!evidence || !isJsonObject(evidence) || Array.isArray(evidence)) {
    throw new Error("DNS validation evidence is required");
  }
  const resolutions = requireArray(evidence.resolutions, "resolutions")
    .map((answer) => ({
      vantage: requireString(answer.vantage, "resolution.vantage"),
      targets: normalizeTargets(answer.targets, "resolution.targets"),
      serial: requireString(answer.serial, "resolution.serial"),
    }))
    .sort((left, right) => left.vantage.localeCompare(right.vantage));

  return {
    resolutions,
    ttl: {
      waitedMs: normalizeMs(evidence.ttl?.waitedMs, "ttl.waitedMs"),
      previousTtlMs: normalizeMs(evidence.ttl?.previousTtlMs, "ttl.previousTtlMs"),
      candidateTtlMs: normalizeMs(evidence.ttl?.candidateTtlMs, "ttl.candidateTtlMs"),
      stableSerialAcrossVantages: evidence.ttl?.stableSerialAcrossVantages === true,
    },
    acme: {
      fqdn: requireDomain(evidence.acme?.fqdn, "acme.fqdn"),
      challengeName: requireString(evidence.acme?.challengeName, "acme.challengeName").toLowerCase(),
      keyThumbprint: requireString(evidence.acme?.keyThumbprint, "acme.keyThumbprint"),
      expectedKeyThumbprint: requireString(evidence.acme?.expectedKeyThumbprint, "acme.expectedKeyThumbprint"),
      csrIdentifier: requireString(evidence.acme?.csrIdentifier, "acme.csrIdentifier"),
      expectedCsrIdentifier: requireString(evidence.acme?.expectedCsrIdentifier, "acme.expectedCsrIdentifier"),
    },
    health: {
      probedHost: requireDomain(evidence.health?.probedHost, "health.probedHost"),
      candidateHost: requireDomain(evidence.health?.candidateHost, "health.candidateHost"),
      gatewayIdentity: requireString(evidence.health?.gatewayIdentity, "health.gatewayIdentity"),
      expectedGatewayIdentity: requireString(evidence.health?.expectedGatewayIdentity, "health.expectedGatewayIdentity"),
      status: normalizeInteger(evidence.health?.status, "health.status"),
    },
  };
}

function normalizeRecord(record) {
  if (!record || !isJsonObject(record) || Array.isArray(record)) {
    throw new Error("record is required");
  }
  return {
    name: requireDomain(record.name, "record.name"),
    type: requireString(record.type, "record.type").toUpperCase(),
    ttl: normalizeInteger(record.ttl, "record.ttl"),
    targets: requireArray(record.targets, "record.targets").map((target) => ({
      camp: requireString(target.camp, "record.target.camp"),
      value: requireString(target.value, "record.target.value"),
    })),
  };
}

function requireLiveZone(liveZone) {
  if (!liveZone || !(liveZone.inspect instanceof Function) || !(liveZone.write instanceof Function)) {
    throw new Error("liveZone with inspect and write is required");
  }
  return liveZone;
}

function digestLiveZone(liveZone, domain) {
  if (!liveZone || !(liveZone.inspect instanceof Function)) {
    throw new Error("liveZone with inspect is required");
  }
  return digestLiveRecords(liveZone.inspect(domain));
}

function digestLiveRecords(records) {
  return `sha256:${createHash("sha256").update(canonicalJson(records.map(normalizeRecord))).digest("hex")}`;
}

function upsert(zones, domain, record) {
  if (!zones.has(domain)) {
    zones.set(domain, new Map());
  }
  zones.get(domain).set(`${record.name}|${record.type}`, clone(record));
}

function recordsFor(zones, domain) {
  return [...(zones.get(domain)?.values() ?? [])]
    .map(clone)
    .sort((left, right) => `${left.name}|${left.type}`.localeCompare(`${right.name}|${right.type}`));
}

function domainEvent(type, data) {
  return Object.freeze({
    type,
    data: deepFreeze({ ...data }),
  });
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeTargets(values, field) {
  return requireArray(values, field).map((value) => requireString(value, field)).sort();
}

function requireArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }
  return value;
}

function requireDomain(value, field) {
  const normalized = requireString(value, field).toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(normalized) || !normalized.includes(".")) {
    throw new Error(`${field} must be a DNS name`);
  }
  return normalized;
}

function requireString(value, field) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error(`${field} must be an integer`);
  }
  return number;
}

function normalizeMs(value, field) {
  const number = normalizeInteger(value, field);
  if (number < 0) {
    throw new Error(`${field} must be >= 0`);
  }
  return number;
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}
