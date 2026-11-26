import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const ALERT_ROUTING_CONTRACT_VERSION = "hobo.alert-routing/v1";

const DEFAULT_MAX_GROUP_SIZE = 100;

export function evaluateAlertRouting(input) {
  const source = expectObject(input, "input");
  const now = normalizeInstant(source.now ?? new Date().toISOString(), "input.now");
  const nowMs = Date.parse(now);
  const previousEvents = normalizeEventArray(source.previousEvents ?? []);
  const signals = normalizeSignals(source.signals ?? []);
  const policy = normalizePolicy(source.policy ?? {});
  const receivers = expectObject(source.receivers ?? {}, "input.receivers");
  const replay = replayAlertEvents(previousEvents);
  const dedupWindowMs = parseDurationMs(policy.dedupWindow);
  const events = [];
  const deliveries = [];
  const pendingDeliveries = [];

  const firing = [];
  for (const signal of signals) {
    if (signal.status === "resolved") {
      events.push(makeEvent("alert.Resolved", now, events, previousEvents, {
        signalId: signal.id,
        fingerprint: signal.fingerprint,
        labels: signal.labels,
      }));
      continue;
    }

    events.push(makeEvent("alert.Fired", now, events, previousEvents, {
      signalId: signal.id,
      fingerprint: signal.fingerprint,
      kind: signal.kind,
      type: signal.type,
      labels: signal.labels,
      metric: signal.metric,
    }));
    firing.push(signal);
  }

  const routed = [];
  const suppressed = new Set();
  const cycle = findInhibitionCycle(policy.inhibitions);
  if (cycle) {
    events.push(makeEvent("alert.InhibitionCycleRejected", now, events, previousEvents, {
      ruleIds: cycle,
      reason: "inhibition-cycle-failed-closed",
    }));
  }

  for (const signal of firing) {
    const silence = findActiveSilence(signal, policy.silences, nowMs);
    if (!silence) {
      continue;
    }
    suppressed.add(signal.fingerprint);
    events.push(makeEvent("alert.Silenced", now, events, previousEvents, {
      signalId: signal.id,
      fingerprint: signal.fingerprint,
      silenceId: silence.id,
      reason: silence.id,
    }));
  }

  if (!cycle) {
    for (const target of firing) {
      if (suppressed.has(target.fingerprint)) {
        continue;
      }
      const inhibited = findInhibition(target, firing, policy.inhibitions);
      if (!inhibited) {
        continue;
      }
      suppressed.add(target.fingerprint);
      events.push(makeEvent("alert.Inhibited", now, events, previousEvents, {
        signalId: target.id,
        fingerprint: target.fingerprint,
        sourceFingerprint: inhibited.source.fingerprint,
        inhibitionId: inhibited.rule.id,
        reason: inhibited.rule.id,
      }));
    }
  }

  for (const signal of firing) {
    if (suppressed.has(signal.fingerprint)) {
      continue;
    }
    const lastRoutedAt = replay.lastRoutedAt[signal.fingerprint];
    if (lastRoutedAt && nowMs - Date.parse(lastRoutedAt) < dedupWindowMs) {
      suppressed.add(signal.fingerprint);
      events.push(makeEvent("alert.Deduped", now, events, previousEvents, {
        signalId: signal.id,
        fingerprint: signal.fingerprint,
        dedupWindow: policy.dedupWindow,
        lastRoutedAt,
        reason: "dedup-window-active",
      }));
      continue;
    }
    routed.push(signal);
  }

  for (const group of buildRouteGroups(routed, policy)) {
    const visibleSignals = group.signals.slice(0, policy.maxGroupSize);
    const overflowCount = Math.max(0, group.signals.length - visibleSignals.length);
    const alertFingerprints = visibleSignals.map((signal) => signal.fingerprint);
    const delivery = {
      routeId: group.route.id,
      receiverId: group.route.receiverId,
      groupKey: group.groupKey,
      alertFingerprints,
      overflowCount,
      sentAt: now,
    };

    events.push(makeEvent("alert.Grouped", now, events, previousEvents, {
      routeId: group.route.id,
      receiverId: group.route.receiverId,
      groupKey: group.groupKey,
      alertFingerprints,
      overflowCount,
    }));

    const deliveryResult = sendDelivery(receivers[group.route.receiverId], delivery);
    if (deliveryResult.ok) {
      const sent = {
        ...delivery,
        providerMessageId: deliveryResult.providerMessageId ?? null,
      };
      deliveries.push(sent);
      events.push(makeEvent("alert.Routed", now, events, previousEvents, {
        ...sent,
        status: "sent",
      }));
      continue;
    }

    const pending = {
      ...delivery,
      retryAfter: deliveryResult.retryAfter ?? "30s",
      error: deliveryResult.error ?? "receiver-send-failed",
    };
    pendingDeliveries.push(pending);
    events.push(makeEvent("alert.Routed", now, events, previousEvents, {
      ...pending,
      status: "retry-scheduled",
    }));
  }

  return {
    schemaVersion: ALERT_ROUTING_CONTRACT_VERSION,
    now,
    events,
    deliveries,
    pendingDeliveries,
  };
}

export function replayAlertEvents(inputEvents) {
  const events = normalizeEventArray(inputEvents);
  const explanations = {};
  const pendingDeliveries = [];
  const lastRoutedAt = {};

  for (const event of events.sort(compareEvents)) {
    const data = event.data ?? {};
    if (event.type === "alert.Fired") {
      explanations[data.fingerprint] = {
        status: "fired",
        reason: "alert-fired",
        eventId: event.id,
        at: event.time,
      };
      continue;
    }

    if (event.type === "alert.Silenced") {
      explanations[data.fingerprint] = {
        status: "silenced",
        reason: data.reason ?? data.silenceId,
        eventId: event.id,
        at: event.time,
      };
      continue;
    }

    if (event.type === "alert.Inhibited") {
      explanations[data.fingerprint] = {
        status: "inhibited",
        reason: data.reason ?? data.inhibitionId,
        eventId: event.id,
        at: event.time,
      };
      continue;
    }

    if (event.type === "alert.Deduped") {
      explanations[data.fingerprint] = {
        status: "deduped",
        reason: data.reason ?? "dedup-window-active",
        eventId: event.id,
        at: event.time,
      };
      continue;
    }

    if (event.type === "alert.Routed") {
      for (const fingerprint of data.alertFingerprints ?? []) {
        lastRoutedAt[fingerprint] = event.time;
        explanations[fingerprint] = {
          status: data.status === "retry-scheduled" ? "retry-scheduled" : "paged",
          reason: data.error ?? data.routeId,
          eventId: event.id,
          at: event.time,
          receiverId: data.receiverId,
        };
      }
      if (data.status === "retry-scheduled") {
        pendingDeliveries.push({
          routeId: data.routeId,
          receiverId: data.receiverId,
          groupKey: data.groupKey,
          alertFingerprints: data.alertFingerprints,
          retryAfter: data.retryAfter,
          error: data.error,
        });
      }
      continue;
    }

    if (event.type === "alert.Resolved") {
      explanations[data.fingerprint] = {
        status: "resolved",
        reason: "alert-resolved",
        eventId: event.id,
        at: event.time,
      };
    }
  }

  return {
    schemaVersion: ALERT_ROUTING_CONTRACT_VERSION,
    explanations,
    pendingDeliveries,
    lastRoutedAt,
  };
}

function normalizePolicy(policy) {
  const source = expectObject(policy, "policy");
  return {
    groupBy: parseStringArray(source.groupBy ?? ["alertname"], "policy.groupBy"),
    dedupWindow: requireDuration(source.dedupWindow ?? "5m", "policy.dedupWindow"),
    maxGroupSize: optionalPositiveInteger(source.maxGroupSize, "policy.maxGroupSize") ?? DEFAULT_MAX_GROUP_SIZE,
    routes: normalizeRoutes(source.routes ?? []),
    silences: normalizeSilences(source.silences ?? []),
    inhibitions: normalizeInhibitions(source.inhibitions ?? []),
  };
}

function normalizeRoutes(routes) {
  if (!Array.isArray(routes)) {
    throw new TypeError("policy.routes must be an array");
  }
  return routes.map((route, index) => {
    const source = expectObject(route, `policy.routes[${index}]`);
    return {
      id: requireString(source.id, `policy.routes[${index}].id`),
      matcher: normalizeMatcher(source.matcher ?? {}, `policy.routes[${index}].matcher`),
      receiverId: requireString(source.receiverId, `policy.routes[${index}].receiverId`),
    };
  });
}

function normalizeSilences(silences) {
  if (!Array.isArray(silences)) {
    throw new TypeError("policy.silences must be an array");
  }
  return silences.map((silence, index) => {
    const source = expectObject(silence, `policy.silences[${index}]`);
    return {
      id: requireString(source.id, `policy.silences[${index}].id`),
      matcher: normalizeMatcher(source.matcher ?? {}, `policy.silences[${index}].matcher`),
      startsAt: normalizeInstant(source.startsAt, `policy.silences[${index}].startsAt`),
      endsAt: normalizeInstant(source.endsAt, `policy.silences[${index}].endsAt`),
    };
  });
}

function normalizeInhibitions(inhibitions) {
  if (!Array.isArray(inhibitions)) {
    throw new TypeError("policy.inhibitions must be an array");
  }
  return inhibitions.map((rule, index) => {
    const source = expectObject(rule, `policy.inhibitions[${index}]`);
    return {
      id: requireString(source.id, `policy.inhibitions[${index}].id`),
      sourceMatcher: normalizeMatcher(source.sourceMatcher ?? {}, `policy.inhibitions[${index}].sourceMatcher`),
      targetMatcher: normalizeMatcher(source.targetMatcher ?? {}, `policy.inhibitions[${index}].targetMatcher`),
      equal: parseStringArray(source.equal ?? [], `policy.inhibitions[${index}].equal`),
    };
  });
}

function normalizeSignals(signals) {
  if (!Array.isArray(signals)) {
    throw new TypeError("input.signals must be an array");
  }
  return signals.map((signal, index) => {
    const source = expectObject(signal, `input.signals[${index}]`);
    const labels = normalizeLabels(source.labels ?? {}, `input.signals[${index}].labels`);
    const normalized = {
      id: requireString(source.id, `input.signals[${index}].id`),
      kind: requireString(source.kind, `input.signals[${index}].kind`),
      type: requireString(source.type, `input.signals[${index}].type`),
      status: source.status === "resolved" ? "resolved" : "firing",
      startsAt: normalizeInstant(source.startsAt, `input.signals[${index}].startsAt`),
      labels,
      metric: normalizeJsonObject(source.metric ?? {}, `input.signals[${index}].metric`),
    };
    return {
      ...normalized,
      fingerprint: stableDigest({
        seed: source.fingerprintSeed ?? normalized.id,
        kind: normalized.kind,
        labels: normalized.labels,
      }),
    };
  });
}

function buildRouteGroups(signals, policy) {
  const groups = new Map();
  for (const signal of signals) {
    const route = policy.routes.find((candidate) => matcherMatches(candidate.matcher, signal));
    if (!route) {
      continue;
    }
    const groupKey = groupKeyFor(signal, policy.groupBy);
    const key = `${route.id}\u0000${route.receiverId}\u0000${groupKey}`;
    const group = groups.get(key) ?? { route, groupKey, signals: [] };
    group.signals.push(signal);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.groupKey.localeCompare(right.groupKey));
}

function findActiveSilence(signal, silences, nowMs) {
  return silences.find(
    (silence) =>
      Date.parse(silence.startsAt) <= nowMs &&
      nowMs < Date.parse(silence.endsAt) &&
      matcherMatches(silence.matcher, signal),
  );
}

function findInhibition(target, signals, inhibitions) {
  for (const rule of inhibitions) {
    if (!matcherMatches(rule.targetMatcher, target)) {
      continue;
    }
    const source = signals.find(
      (candidate) =>
        candidate.fingerprint !== target.fingerprint &&
        matcherMatches(rule.sourceMatcher, candidate) &&
        equalLabelsMatch(rule.equal, candidate, target),
    );
    if (source) {
      return { rule, source };
    }
  }
  return null;
}

function findInhibitionCycle(rules) {
  const edges = rules.map((rule) => ({
    id: rule.id,
    from: canonicalJson(rule.sourceMatcher),
    to: canonicalJson(rule.targetMatcher),
  }));
  const bySource = groupEdgesBySource(edges);

  for (const edge of edges) {
    if (edge.from === edge.to) {
      return [edge.id];
    }
    const cycle = findCycleFrom(edge, bySource, new Set(), []);
    if (cycle) {
      return cycle.sort();
    }
  }
  return null;
}

function groupEdgesBySource(edges) {
  const bySource = new Map();
  for (const edge of edges) {
    const group = bySource.get(edge.from) ?? [];
    group.push(edge);
    bySource.set(edge.from, group);
  }
  return bySource;
}

function findCycleFrom(edge, bySource, visitedEdges, path) {
  if (path.some((candidate) => candidate.from === edge.to)) {
    return [...path, edge].map((candidate) => candidate.id);
  }
  if (visitedEdges.has(edge.id)) {
    return null;
  }
  visitedEdges.add(edge.id);

  for (const next of bySource.get(edge.to) ?? []) {
    const cycle = findCycleFrom(next, bySource, visitedEdges, [...path, edge]);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

function equalLabelsMatch(keys, source, target) {
  return keys.every((key) => signalValue(source, key) === signalValue(target, key));
}

function matcherMatches(matcher, signal) {
  return Object.entries(matcher).every(([key, expected]) => signalValue(signal, key) === expected);
}

function signalValue(signal, key) {
  if (key === "kind") {
    return signal.kind;
  }
  if (key === "type") {
    return signal.type;
  }
  if (key === "status") {
    return signal.status;
  }
  return signal.labels[key];
}

function groupKeyFor(signal, groupBy) {
  return groupBy.map((key) => `${key}=${signalValue(signal, key) ?? "<missing>"}`).join(",");
}

function sendDelivery(receiver, delivery) {
  if (!receiver || !(receiver.send instanceof Function)) {
    return { ok: false, error: "receiver-missing", retryAfter: "30s" };
  }
  try {
    const result = receiver.send(delivery);
    return result && isJsonObject(result) ? result : { ok: false, error: "receiver-returned-non-object" };
  } catch (error) {
    return { ok: false, error: error.message, retryAfter: "30s" };
  }
}

function makeEvent(type, time, newEvents, previousEvents, data) {
  const event = {
    schemaVersion: ALERT_ROUTING_CONTRACT_VERSION,
    id: `${type}:${stableDigest({ type, time, data })}`,
    type,
    seq: previousEvents.length + newEvents.length + 1,
    time,
    data: sortKeys(data),
  };
  return event;
}

function normalizeEventArray(events) {
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  return events.map((event, index) => {
    const source = expectObject(event, `events[${index}]`);
    return {
      ...source,
      id: requireString(source.id, `events[${index}].id`),
      type: requireString(source.type, `events[${index}].type`),
      seq: requireNonNegativeInteger(source.seq, `events[${index}].seq`),
      time: normalizeInstant(source.time, `events[${index}].time`),
      data: normalizeJsonObject(source.data ?? {}, `events[${index}].data`),
    };
  });
}

function compareEvents(left, right) {
  return left.seq - right.seq || left.id.localeCompare(right.id);
}

function normalizeMatcher(input, path) {
  return normalizeLabels(input, path);
}

function normalizeLabels(input, path) {
  const source = expectObject(input, path);
  return Object.fromEntries(
    Object.entries(source)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [requireString(key, `${path}.key`), requireString(value, `${path}.${key}`)]),
  );
}

function normalizeJsonObject(input, path) {
  const source = expectObject(input, path);
  return sortKeys(source);
}

function expectObject(input, fieldName) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  return input;
}

function parseStringArray(input, fieldName) {
  if (!Array.isArray(input)) {
    throw new TypeError(`${fieldName} must be an array`);
  }
  return input.map((value, index) => requireString(value, `${fieldName}[${index}]`));
}

function optionalPositiveInteger(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function requireString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function normalizeInstant(value, fieldName) {
  if (!isJsonString(value)) {
    throw new TypeError(`${fieldName} must be an ISO-8601 string`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 string`);
  }
  return new Date(timestamp).toISOString();
}

function requireDuration(value, fieldName) {
  parseDurationMs(value, fieldName);
  return value;
}

function parseDurationMs(value, fieldName = "duration") {
  if (value === undefined || value === null) {
    return 0;
  }
  const match = /^([1-9][0-9]*)(s|m|h|d)$/.exec(value);
  if (!match) {
    throw new TypeError(`${fieldName} must be a duration like 30s, 5m, 1h, or 1d`);
  }
  const units = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Number(match[1]) * units[match[2]];
}

function stableDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}
