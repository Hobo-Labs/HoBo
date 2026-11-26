import { createHash } from "node:crypto";
import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";


export const METERING_VIEW = "MeteringView";

const METERING_EVENT_TYPES = new Set(["meter.UsageRecorded", "meter.CounterRecorded"]);

export function snapshotMeteringView(events, options = {}) {
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }

  const seq = requireNonNegativeInteger(options.seq, "options.seq");
  const costCatalog = normalizeCostCatalog(options.costCatalog);
  const state = emptyState(costCatalog.currency);
  const acceptedEvents = [];
  const seenIdempotencyKeys = new Map();

  for (const event of events.filter((event) => eventSeq(event) <= seq).sort(compareEvents)) {
    if (!METERING_EVENT_TYPES.has(event.type)) {
      continue;
    }
    const idempotencyKey = requireString(event.idempotencyKey ?? event.id, "event.idempotencyKey");
    if (seenIdempotencyKeys.has(idempotencyKey)) {
      state.deduplicatedEvents.push({
        eventId: requireString(event.id, "event.id"),
        idempotencyKey,
        originalEventId: seenIdempotencyKeys.get(idempotencyKey),
      });
      continue;
    }
    seenIdempotencyKeys.set(idempotencyKey, requireString(event.id, "event.id"));
    foldUsage(state, event, costCatalog);
    acceptedEvents.push(event);
  }

  return attachSourceEvents(materialize(state, seq), acceptedEvents);
}

export function applyMeteringEvent(view, event, options = {}) {
  if (!view || view.view !== METERING_VIEW || !Array.isArray(view.__events)) {
    throw new TypeError("view must be a MeteringView snapshot produced by snapshotMeteringView");
  }
  return snapshotMeteringView([...view.__events, event], {
    seq: Math.max(view.seq, eventSeq(event)),
    costCatalog: options.costCatalog,
  });
}

export function emitMeterRollups(snapshot) {
  if (!snapshot || snapshot.view !== METERING_VIEW) {
    throw new TypeError("snapshot must be a MeteringView snapshot");
  }

  return Object.entries(snapshot.totals)
    .filter(([, counter]) => counter.quantity !== 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dimension, counter]) => ({
      type: "meter.RollupEmitted",
      seq: snapshot.seq,
      meteringViewDigest: snapshot.digest,
      dimension,
      quantity: counter.quantity,
      cost: counter.cost,
      currency: counter.currency,
    }));
}

function foldUsage(state, event, costCatalog) {
  const dimension = requireDimension(event.dimension);
  const quantity = requireFinitePositiveNumber(event.quantity, "event.quantity");
  const occurredAt = normalizeInstant(event.occurredAt, "event.occurredAt");
  const owner = normalizeOwnerOrNull(event.owner);
  if (!owner) {
    state.attributionGaps.push({
      eventId: requireString(event.id, "event.id"),
      seq: eventSeq(event),
      dimension,
      reason: "missing-owning-principal",
    });
    return;
  }
  const unitPrice = resolveUnitPrice(costCatalog, dimension, event.priceKey);
  const cost = roundCost(quantity * unitPrice);
  const period = occurredAt.slice(0, 10);

  addCounter(state.totals, dimension, quantity, cost, costCatalog.currency);
  addCounter(ensureBucket(state.buckets, period).counters, dimension, quantity, cost, costCatalog.currency);
  addPrincipalHierarchy(state.principalHierarchy, owner);
}

function materialize(state, seq) {
  const payload = {
    view: METERING_VIEW,
    seq,
    currency: state.currency,
    totals: sortKeys(state.totals),
    totalCost: roundCost(Object.values(state.totals).reduce((total, counter) => total + counter.cost, 0)),
    buckets: [...state.buckets.values()]
      .map((bucket) => ({ ...bucket, counters: sortKeys(bucket.counters) }))
      .sort((left, right) => left.period.localeCompare(right.period)),
    principalHierarchy: Object.fromEntries(
      Object.entries(state.principalHierarchy).map(([key, values]) => [key, [...values].sort()]),
    ),
    attributionGaps: [...state.attributionGaps].sort(compareAttributionGaps),
    deduplicatedEvents: [...state.deduplicatedEvents].sort(compareDeduplicatedEvents),
  };

  return {
    ...payload,
    digest: sha256(canonicalJson(payload)),
  };
}

function emptyState(currency) {
  return {
    currency,
    totals: {},
    buckets: new Map(),
    principalHierarchy: {
      tenants: new Set(),
      camps: new Set(),
      bindles: new Set(),
      runs: new Set(),
      agents: new Set(),
      teams: new Set(),
    },
    attributionGaps: [],
    deduplicatedEvents: [],
  };
}

function ensureBucket(buckets, period) {
  if (!buckets.has(period)) {
    buckets.set(period, { period, counters: {} });
  }
  return buckets.get(period);
}

function addCounter(counters, dimension, quantity, cost, currency) {
  counters[dimension] ??= { quantity: 0, cost: 0, currency };
  const nextQuantity = counters[dimension].quantity + quantity;
  if (Math.abs(nextQuantity) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`counter overflow for ${dimension}`);
  }
  counters[dimension] = {
    quantity: roundQuantity(nextQuantity),
    cost: roundCost(counters[dimension].cost + cost),
    currency,
  };
}

function addPrincipalHierarchy(hierarchy, owner) {
  hierarchy.tenants.add(owner.tenantId);
  hierarchy.camps.add(`${owner.tenantId}/${owner.campId}`);
  hierarchy.bindles.add(`${owner.tenantId}/${owner.campId}/${owner.bindleId}`);
  if (owner.runId) {
    hierarchy.runs.add(`${owner.tenantId}/${owner.campId}/${owner.bindleId}/${owner.runId}`);
  }
  if (owner.agentId) {
    hierarchy.agents.add(`${owner.tenantId}/${owner.agentId}`);
  }
  if (owner.teamId) {
    hierarchy.teams.add(`${owner.tenantId}/${owner.teamId}`);
  }
}

function normalizeOwner(owner) {
  if (!owner || !isJsonObject(owner) || Array.isArray(owner)) {
    throw new TypeError("event.owner must be an object");
  }
  return {
    tenantId: requireString(owner.tenantId, "event.owner.tenantId"),
    campId: requireString(owner.campId, "event.owner.campId"),
    bindleId: requireString(owner.bindleId, "event.owner.bindleId"),
    runId: optionalString(owner.runId, "event.owner.runId"),
    agentId: optionalString(owner.agentId, "event.owner.agentId"),
    teamId: optionalString(owner.teamId, "event.owner.teamId"),
  };
}

function normalizeOwnerOrNull(owner) {
  if (!owner || !isJsonObject(owner) || Array.isArray(owner)) {
    return null;
  }
  try {
    return normalizeOwner(owner);
  } catch {
    return null;
  }
}

function compareAttributionGaps(left, right) {
  return left.seq - right.seq || left.eventId.localeCompare(right.eventId);
}

function compareDeduplicatedEvents(left, right) {
  return left.idempotencyKey.localeCompare(right.idempotencyKey) || left.eventId.localeCompare(right.eventId);
}

function normalizeCostCatalog(costCatalog) {
  if (!costCatalog || !isJsonObject(costCatalog) || Array.isArray(costCatalog)) {
    throw new TypeError("options.costCatalog must be an object");
  }
  const currency = requireString(costCatalog.currency, "costCatalog.currency");
  if (!costCatalog.unitPrices || !isJsonObject(costCatalog.unitPrices)) {
    throw new TypeError("costCatalog.unitPrices must be an object");
  }
  return { currency, unitPrices: costCatalog.unitPrices };
}

function resolveUnitPrice(costCatalog, dimension, priceKey) {
  const price = costCatalog.unitPrices[dimension];
  if (isJsonNumber(price)) {
    if (price < 0) {
      throw new RangeError(`unit price for ${dimension} must be non-negative`);
    }
    return price;
  }
  if (price && isJsonObject(price)) {
    const key = requireString(priceKey, "event.priceKey");
    const keyed = price[key];
    if (!Number.isFinite(keyed) || keyed < 0) {
      throw new RangeError(`unit price for ${dimension}/${key} must be non-negative`);
    }
    return keyed;
  }
  throw new RangeError(`missing unit price for ${dimension}`);
}

function compareEvents(left, right) {
  const seqDelta = eventSeq(left) - eventSeq(right);
  if (seqDelta !== 0) {
    return seqDelta;
  }
  return requireString(left.id, "event.id").localeCompare(requireString(right.id, "event.id"));
}

function eventSeq(event) {
  return requireNonNegativeInteger(event?.seq, "event.seq");
}

function requireDimension(value) {
  return requireString(value, "event.dimension");
}

function normalizeInstant(value, fieldName) {
  if (!isJsonString(value)) {
    throw new TypeError(`${fieldName} must be an ISO-8601 string`);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 string`);
  }
  return new Date(timestamp).toISOString();
}

function requireString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function optionalString(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }
  return requireString(value, fieldName);
}

function requireFinitePositiveNumber(value, fieldName) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${fieldName} must be greater than 0`);
  }
  return value;
}

function requireNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function attachSourceEvents(snapshot, events) {
  Object.defineProperty(snapshot, "__events", {
    value: [...events],
    enumerable: false,
  });
  return snapshot;
}

function roundCost(value) {
  return Number(value.toFixed(12));
}

function roundQuantity(value) {
  return Number(value.toFixed(9));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
