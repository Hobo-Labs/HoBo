import { isJsonString, isJsonObject } from "./json.js";
export function createCutoverDnsAdapter({ domain, liveRecords = [] } = {}) {
  const defaultDomain = requireString(domain, "domain");
  const liveZones = new Map([[defaultDomain, new Map()]]);
  const writes = [];

  for (const record of liveRecords) {
    setLiveRecord(liveZones, defaultDomain, record);
  }

  return {
    writes,

    inspectLiveZone(zoneDomain = defaultDomain) {
      return allRecords(zone(liveZones, zoneDomain));
    },

    replaceLiveRecord(zoneDomain, record, stage) {
      const normalizedDomain = requireString(zoneDomain, "domain");
      const normalized = cloneRecord(record);
      setLiveRecord(liveZones, normalizedDomain, normalized);
      writes.push({
        domain: normalizedDomain,
        stage,
        record: cloneRecord(normalized),
      });
    },
  };
}

export async function runHealthCheckedCutover(request) {
  const normalized = normalizeRequest(request);
  const refusal = refusalReason(normalized);
  if (refusal) {
    return cutoverResult("refused", [cutoverEvent("domain.CutoverRefused", normalized, { reason: refusal })], refusal);
  }

  const events = [];
  const effectiveRtoSeconds = normalized.ttlPrecondition.previousTtlSeconds;
  const lowered = withTtl(normalized.lastKnownGood, normalized.ttlPrecondition.loweredTtlSeconds);

  normalized.adapter.replaceLiveRecord(normalized.domain, lowered, "ttl-lowered");
  events.push(
    cutoverEvent("domain.TtlLowered", normalized, {
      record: lowered,
      previousTtlSeconds: normalized.ttlPrecondition.previousTtlSeconds,
      loweredTtlSeconds: normalized.ttlPrecondition.loweredTtlSeconds,
      waitedSeconds: normalized.ttlPrecondition.waitedSeconds,
      effectiveRtoSeconds,
    }),
  );

  events.push(
    cutoverEvent("domain.CutoverStarted", normalized, {
      validationChangeId: normalized.validation.changeId,
      effectiveRtoSeconds,
    }),
  );

  const canary = canaryRecord(normalized.lastKnownGood, normalized.candidateRecord, normalized.canaryWeight);
  normalized.adapter.replaceLiveRecord(normalized.domain, canary, "canary");
  events.push(
    cutoverEvent("domain.RoutingChanged", normalized, {
      stage: "canary",
      record: canary,
      reason: `shifted ${normalized.canaryWeight}% to candidate after TTL precondition`,
    }),
  );

  const regression = findRegression(normalized.healthSamples, normalized.hysteresis.consecutiveFailuresToRollback);
  if (regression.rollback) {
    normalized.adapter.replaceLiveRecord(normalized.domain, normalized.lastKnownGood, "rollback");
    events.push(
      cutoverEvent("domain.RolledBack", normalized, {
        reason: regression.reason,
        record: normalized.lastKnownGood,
        effectiveRtoSeconds,
      }),
    );
    return cutoverResult("rolled-back", events);
  }

  if (regression.observed) {
    return cutoverResult("watching", events);
  }

  const final = finalRecord(normalized.candidateRecord);
  normalized.adapter.replaceLiveRecord(normalized.domain, final, "complete");
  events.push(
    cutoverEvent("domain.RoutingChanged", normalized, {
      stage: "complete",
      record: final,
      reason: "health and SLO stayed green through canary",
    }),
  );

  return cutoverResult("routed", events);
}

function normalizeRequest(request) {
  if (!request || !isJsonObject(request)) {
    throw new Error("cutover request is required");
  }
  const domain = requireString(request.domain, "domain");
  const camp = requireString(request.camp, "camp");
  const recordName = requireString(request.recordName, "recordName");
  const validation = request.validation;
  const adapter = request.adapter;
  if (!adapter || !(adapter.inspectLiveZone instanceof Function) || !(adapter.replaceLiveRecord instanceof Function)) {
    throw new Error("cutover adapter must expose inspectLiveZone and replaceLiveRecord");
  }

  return {
    domain,
    camp,
    recordName,
    validation,
    adapter,
    candidateRecord: cloneRecord(request.candidateRecord),
    lastKnownGood: cloneRecord(request.lastKnownGood),
    ttlPrecondition: normalizeTtlPrecondition(request.ttlPrecondition),
    healthSamples: Array.isArray(request.healthSamples) ? request.healthSamples.map((sample) => ({ ...sample })) : [],
    hysteresis: {
      consecutiveFailuresToRollback: normalizePositiveInteger(
        request.hysteresis?.consecutiveFailuresToRollback ?? 2,
        "consecutiveFailuresToRollback",
      ),
    },
    canaryWeight: normalizeCanaryWeight(request.canaryWeight ?? 10),
  };
}

function refusalReason(request) {
  if (request.validation?.status !== "validated") {
    return "cutover requires a validated domain change";
  }

  const current = request.adapter.inspectLiveZone(request.domain).find((record) => record.name === request.recordName);
  if (!current) {
    return `last-known-good record ${request.recordName} is not present in the current live zone`;
  }
  if (canonicalJson(current) !== canonicalJson(request.lastKnownGood)) {
    return "last-known-good record must match the current live zone before cutover";
  }

  const ttl = request.ttlPrecondition;
  if (ttl.loweredTtlSeconds >= ttl.previousTtlSeconds) {
    return `lowered TTL ${ttl.loweredTtlSeconds}s must be below previous TTL ${ttl.previousTtlSeconds}s`;
  }
  if (ttl.waitedSeconds < ttl.previousTtlSeconds) {
    return `waited ${ttl.waitedSeconds}s, below previous TTL ${ttl.previousTtlSeconds}s`;
  }

  return null;
}

function normalizeTtlPrecondition(value) {
  if (!value || !isJsonObject(value)) {
    throw new Error("ttlPrecondition is required");
  }
  return {
    previousTtlSeconds: normalizePositiveInteger(value.previousTtlSeconds, "previousTtlSeconds"),
    loweredTtlSeconds: normalizePositiveInteger(value.loweredTtlSeconds, "loweredTtlSeconds"),
    waitedSeconds: normalizePositiveInteger(value.waitedSeconds, "waitedSeconds"),
  };
}

function findRegression(samples, threshold) {
  let consecutive = 0;
  let observed = false;

  for (const sample of samples) {
    const failed = sample.healthy !== true || sample.sloOk !== true;
    if (!failed) {
      consecutive = 0;
      continue;
    }

    observed = true;
    consecutive += 1;
    if (consecutive >= threshold) {
      return {
        observed: true,
        rollback: true,
        reason: sample.reason ?? "health or SLO regression exceeded hysteresis",
      };
    }
  }

  return { observed, rollback: false };
}

function withTtl(record, ttl) {
  return {
    ...cloneRecord(record),
    ttl,
  };
}

function canaryRecord(lastKnownGood, candidate, canaryWeight) {
  const stableWeight = 100 - canaryWeight;
  return {
    ...cloneRecord(candidate),
    targets: [...cloneRecord(lastKnownGood.targets), ...cloneRecord(candidate.targets)],
    policy: {
      kind: "weighted",
      targets: [
        { camp: lastKnownGood.targets[0].camp, weight: stableWeight },
        { camp: candidate.targets[0].camp, weight: canaryWeight },
      ],
    },
  };
}

function finalRecord(candidate) {
  return {
    ...cloneRecord(candidate),
    policy: {
      kind: "weighted",
      targets: [{ camp: candidate.targets[0].camp, weight: 100 }],
    },
  };
}

function cutoverEvent(type, request, data) {
  return {
    type,
    domain: request.domain,
    camp: request.camp,
    data: cloneRecord(data),
  };
}

function cutoverResult(status, events, reason) {
  return Object.freeze({
    status,
    ...(reason ? { reason } : undefined),
    events: events.map((event) => deepFreeze(event)),
  });
}

function normalizeCanaryWeight(value) {
  const normalized = normalizePositiveInteger(value, "canaryWeight");
  if (normalized >= 100) {
    throw new Error("canaryWeight must be below 100");
  }
  return normalized;
}

function normalizePositiveInteger(value, field) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return normalized;
}

function setLiveRecord(liveZones, domain, record) {
  zone(liveZones, domain).set(recordKey(record.name, record.type), cloneRecord(record));
}

function zone(liveZones, domain) {
  if (!liveZones.has(domain)) {
    liveZones.set(domain, new Map());
  }
  return liveZones.get(domain);
}

function allRecords(records) {
  return [...records.values()]
    .map(cloneRecord)
    .sort((left, right) => recordKey(left.name, left.type).localeCompare(recordKey(right.name, right.type)));
}

function recordKey(name, type) {
  return `${name}|${type}`;
}

function cloneRecord(value) {
  return JSON.parse(JSON.stringify(value));
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

function requireString(value, field) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
