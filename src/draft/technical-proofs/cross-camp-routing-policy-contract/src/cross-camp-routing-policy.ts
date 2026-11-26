import { isJsonString, isJsonObject } from "./json.js";
export function routeCrossCampTraffic(request) {
  const normalized = normalizeRequest(request);
  if (normalized.policy.kind === "weighted") {
    return routeWeighted(normalized);
  }

  if (normalized.policy.kind === "failover") {
    return routeFailover(normalized);
  }

  if (normalized.policy.kind === "latency") {
    return routeLatency(normalized);
  }

  if (normalized.policy.kind === "geo") {
    return routeGeo(normalized);
  }

  throw new Error(`unsupported routing policy: ${normalized.policy.kind}`);
}

function routeWeighted(normalized) {
  const invalidTarget = normalized.policy.targets.find((target) => !isValidatedHealthy(normalized.camps.get(target.camp)));
  if (invalidTarget) {
    return routeResult(
      "refused",
      null,
      [],
      `weighted target ${invalidTarget.camp} is not validation-cleared and healthy`,
    );
  }

  const record = {
    name: normalized.recordName,
    type: normalized.recordType,
    ttl: normalized.ttl,
    targets: normalized.policy.targets.map((target) => campTarget(normalized.camps, target.camp)),
    policy: clone(normalized.policy),
  };

  return routeResult("routed", record, [
    routingChanged(normalized, {
      policy: "weighted",
      targetCamps: normalized.policy.targets.map((target) => target.camp),
      reason: `weighted split ${normalized.policy.targets.map((target) => `${target.camp}=${target.weight}`).join(", ")}`,
    }),
  ]);
}

function routeFailover(normalized) {
  const failureCount = consecutiveActiveFailures(
    normalized.healthSamples,
    normalized.activeCamp,
    normalized.sustainedFailureThreshold,
  );
  if (failureCount < normalized.sustainedFailureThreshold) {
    return routeResult("held", null, []);
  }

  const target = [...normalized.policy.targets]
    .sort((left, right) => left.priority - right.priority)
    .find((entry) => entry.camp !== normalized.activeCamp && isValidatedHealthy(normalized.camps.get(entry.camp)));

  if (!target) {
    return routeResult("refused", null, [], "no validation-cleared failover target is healthy");
  }

  const record = {
    name: normalized.recordName,
    type: normalized.recordType,
    ttl: normalized.ttl,
    targets: [campTarget(normalized.camps, target.camp)],
    policy: {
      kind: "failover",
      targets: [{ camp: target.camp, priority: 1 }],
    },
  };

  return routeResult("routed", record, [
    routingChanged(normalized, {
      policy: "failover",
      targetCamp: target.camp,
      targetCamps: [target.camp],
      reason: `active Camp ${normalized.activeCamp} failed ${failureCount} consecutive health checks; failed over to ${target.camp}`,
    }),
  ]);
}

function routeLatency(normalized) {
  const target = [...normalized.policy.targets]
    .map((entry) => ({ entry, camp: normalized.camps.get(entry.camp) }))
    .filter(({ camp }) => isValidatedHealthy(camp))
    .sort((left, right) => numeric(left.camp.latencyMs, "latencyMs") - numeric(right.camp.latencyMs, "latencyMs"))[0];

  if (!target) {
    return routeResult("refused", null, [], "no validation-cleared healthy latency target is available");
  }

  const record = singleCampRecord(normalized, target.entry, {
    kind: "latency",
    targets: [{ camp: target.entry.camp, region: target.entry.region }],
  });

  return routeResult("routed", record, [
    routingChanged(normalized, {
      policy: "latency",
      targetCamp: target.entry.camp,
      targetCamps: [target.entry.camp],
      reason: `lowest healthy latency target is ${target.entry.camp} at ${target.camp.latencyMs}ms`,
    }),
  ]);
}

function routeGeo(normalized) {
  if (!normalized.clientGeo) {
    throw new Error("clientGeo is required for geo routing");
  }

  const target = [...normalized.policy.targets]
    .map((entry) => ({ entry, camp: normalized.camps.get(entry.camp) }))
    .filter(({ camp }) => isValidatedHealthy(camp))
    .sort((left, right) => geoRank(left, normalized.clientGeo) - geoRank(right, normalized.clientGeo))[0];

  if (!target) {
    return routeResult("refused", null, [], "no validation-cleared healthy geo target is available");
  }

  const record = singleCampRecord(normalized, target.entry, {
    kind: "geo",
    targets: [{ camp: target.entry.camp, geo: target.entry.geo }],
  });

  return routeResult("routed", record, [
    routingChanged(normalized, {
      policy: "geo",
      targetCamp: target.entry.camp,
      targetCamps: [target.entry.camp],
      reason: `nearest healthy geography for ${normalized.clientGeo} is ${target.entry.camp} (${target.entry.geo})`,
    }),
  ]);
}

function normalizeRequest(request) {
  if (!request || !isJsonObject(request)) {
    throw new Error("routing request is required");
  }
  return {
    domain: requireString(request.domain, "domain"),
    recordName: requireString(request.recordName, "recordName"),
    recordType: requireString(request.recordType ?? "A", "recordType").toUpperCase(),
    ttl: positiveInteger(request.ttl ?? 60, "ttl"),
    policy: clone(request.policy),
    camps: new Map((request.camps ?? []).map((camp) => [requireString(camp.camp, "camp"), { ...camp }])),
    activeCamp: request.activeCamp ? requireString(request.activeCamp, "activeCamp") : null,
    clientGeo: request.clientGeo ? requireString(request.clientGeo, "clientGeo") : null,
    sustainedFailureThreshold: positiveInteger(request.sustainedFailureThreshold ?? 2, "sustainedFailureThreshold"),
    healthSamples: Array.isArray(request.healthSamples) ? request.healthSamples.map((sample) => ({ ...sample })) : [],
  };
}

function campTarget(camps, campName) {
  const camp = camps.get(campName);
  if (!camp) {
    throw new Error(`unknown Camp: ${campName}`);
  }
  return {
    camp: campName,
    value: requireString(camp.value, `${campName}.value`),
  };
}

function singleCampRecord(request, target, policy) {
  return {
    name: request.recordName,
    type: request.recordType,
    ttl: request.ttl,
    targets: [campTarget(request.camps, target.camp)],
    policy,
  };
}

function consecutiveActiveFailures(samples, activeCamp, cap) {
  if (!activeCamp) {
    throw new Error("activeCamp is required for failover routing");
  }
  let consecutive = 0;
  for (const sample of samples) {
    if (sample.camp !== activeCamp) {
      continue;
    }
    if (sample.healthy === true && sample.sloOk !== false) {
      consecutive = 0;
      continue;
    }
    consecutive += 1;
  }
  return Math.min(consecutive, cap);
}

function isValidatedHealthy(camp) {
  return camp?.validated === true && camp?.healthy === true;
}

function geoRank(candidate, clientGeo) {
  if (candidate.entry.geo === clientGeo) {
    return 0;
  }
  return numeric(candidate.camp.geoDistance, "geoDistance");
}

function routingChanged(request, data) {
  return {
    type: "domain.RoutingChanged",
    domain: request.domain,
    recordName: request.recordName,
    data,
  };
}

function routeResult(status, record, events, reason) {
  return deepFreeze({
    status,
    ...(reason ? { reason } : undefined),
    ...(record ? { record: clone(record) } : undefined),
    events: clone(events),
  });
}

function requireString(value, field) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value, field) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return normalized;
}

function numeric(value, field) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    throw new Error(`${field} must be numeric`);
  }
  return normalized;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
