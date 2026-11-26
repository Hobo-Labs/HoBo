import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const SHARED_COST_SCHEMA_VERSION = "hobo.shared-cost-attribution/v1";
export const TENANT_SHOWBACK_SCHEMA_VERSION = "hobo.tenant-shared-cost-showback/v1";

const SPLIT_STRATEGIES = new Set(["usage-share", "equal", "weighted"]);

export function allocateSharedResourceCost(input) {
  const source = expectObject(input, "input");
  const resourceId = requireString(source.resourceId, "input.resourceId");
  const period = requireString(source.period, "input.period");
  const currency = optionalString(source.currency, "input.currency") ?? "USD";
  const totalCostCents = requireNonNegativeInteger(source.totalCostCents, "input.totalCostCents");
  const fixedOverheadCents = requireNonNegativeInteger(source.fixedOverheadCents ?? 0, "input.fixedOverheadCents");
  if (fixedOverheadCents > totalCostCents) {
    throw new RangeError("input.fixedOverheadCents must not exceed input.totalCostCents");
  }
  const ownerPrincipal = normalizeOwnerPrincipal(source.ownerPrincipal);
  const policy = normalizePolicy(source.policy);
  const costFactId = `resource-cost:${resourceId}:${period}`;
  const fixedFactId = fixedOverheadCents > 0 ? `fixed-overhead:${resourceId}:${period}` : null;
  const consumers = normalizeConsumers(source.consumers ?? []);
  const replay = replayUsageEvents(source.usageEvents ?? [], resourceId);
  const consumerMap = new Map();

  for (const consumer of consumers) {
    mergeConsumer(consumerMap, consumer);
  }
  for (const event of replay.events) {
    mergeConsumer(consumerMap, event.consumer, event);
  }

  if (consumerMap.size === 0) {
    if (ownerPrincipal.kind === "platform") {
      return materializeAllocation({
        resourceId,
        period,
        currency,
        totalCostCents,
        fixedOverheadCents,
        policy,
        ownerPrincipal,
        shares: [],
        systemOverheadCents: totalCostCents,
        systemOverheadReason: "platform-owned-shared-resource-without-consumer-facts",
        auditFacts: costAuditFacts({ costFactId, fixedFactId, totalCostCents, fixedOverheadCents }),
        deduplicatedUsageEvents: replay.deduplicatedUsageEvents,
      });
    }
    throw new RangeError("shared cost attribution requires consumer facts or a platform system bucket");
  }

  const materializedConsumers = [...consumerMap.values()].sort(compareConsumers);
  const consumerKeys = materializedConsumers.map((consumer) => consumer.consumerKey);
  const fixedShares = allocateCents(fixedOverheadCents, consumerKeys.map((key) => ({ key, weight: 1 })));
  const variableCents = totalCostCents - fixedOverheadCents;
  const variableShares = allocateVariableCents(variableCents, policy.strategy, materializedConsumers, ownerPrincipal);
  const shares = materializedConsumers.map((consumer) => {
    const fixedCents = fixedShares.get(consumer.consumerKey) ?? 0;
    const variableShareCents = variableShares.shares.get(consumer.consumerKey) ?? 0;
    return materializeShare({
      consumer,
      currency,
      costFactId,
      fixedFactId,
      fixedCents,
      variableShareCents,
    });
  });
  const auditFacts = [
    ...costAuditFacts({ costFactId, fixedFactId, totalCostCents, fixedOverheadCents }),
    ...materializedConsumers.flatMap(consumerAuditFacts),
  ];

  return materializeAllocation({
    resourceId,
    period,
    currency,
    totalCostCents,
    fixedOverheadCents,
    policy,
    ownerPrincipal,
    shares,
    systemOverheadCents: variableShares.systemOverheadCents,
    systemOverheadReason: variableShares.systemOverheadReason,
    auditFacts,
    deduplicatedUsageEvents: replay.deduplicatedUsageEvents,
  });
}

export function showbackForTenant(allocation, tenantId) {
  const source = expectObject(allocation, "allocation");
  const requestedTenantId = requireString(tenantId, "tenantId");
  const shares = expectArray(source.shares, "allocation.shares")
    .filter((share) => share.tenantId === requestedTenantId)
    .map((share) => ({
      resourceId: source.resourceId,
      period: source.period,
      consumerKey: share.consumerKey,
      tenantId: share.tenantId,
      campId: share.campId,
      bindleId: share.bindleId,
      costCents: share.costCents,
      fixedOverheadCents: share.fixedOverheadCents,
      variableCents: share.variableCents,
      currency: share.currency,
      usageUnits: share.usageUnits,
      usageEventIds: [...share.usageEventIds],
      auditFactIds: [...share.auditFactIds],
    }));
  return {
    schemaVersion: TENANT_SHOWBACK_SCHEMA_VERSION,
    tenantId: requestedTenantId,
    currency: source.currency,
    totalCostCents: shares.reduce((total, share) => total + share.costCents, 0),
    shares,
  };
}

function allocateVariableCents(variableCents, strategy, consumers, ownerPrincipal) {
  if (variableCents === 0) {
    return { shares: new Map(), systemOverheadCents: 0, systemOverheadReason: null };
  }

  if (strategy === "usage-share") {
    const weightedConsumers = consumers.map((consumer) => ({
      key: consumer.consumerKey,
      weight: consumer.usageUnits,
    }));
    if (weightedConsumers.every((consumer) => consumer.weight === 0)) {
      if (ownerPrincipal.kind === "platform") {
        return {
          shares: new Map(),
          systemOverheadCents: variableCents,
          systemOverheadReason: "platform-owned-shared-resource-without-usage-facts",
        };
      }
      throw new RangeError("usage-share split requires positive usage units for variable cost");
    }
    return { shares: allocateCents(variableCents, weightedConsumers), systemOverheadCents: 0, systemOverheadReason: null };
  }

  if (strategy === "equal") {
    return {
      shares: allocateCents(
        variableCents,
        consumers.map((consumer) => ({ key: consumer.consumerKey, weight: 1 })),
      ),
      systemOverheadCents: 0,
      systemOverheadReason: null,
    };
  }

  return {
    shares: allocateCents(
      variableCents,
      consumers.map((consumer) => ({ key: consumer.consumerKey, weight: consumer.weight })),
    ),
    systemOverheadCents: 0,
    systemOverheadReason: null,
  };
}

function materializeShare({ consumer, currency, costFactId, fixedFactId, fixedCents, variableShareCents }) {
  const auditFactIds = [
    costFactId,
    fixedFactId && fixedCents > 0 ? fixedFactId : null,
    consumer.registrationEventId,
    ...consumer.usageEventIds,
  ].filter(Boolean);
  return {
    consumerKey: consumer.consumerKey,
    tenantId: consumer.tenantId,
    campId: consumer.campId,
    bindleId: consumer.bindleId,
    registrationEventId: consumer.registrationEventId,
    costCents: fixedCents + variableShareCents,
    fixedOverheadCents: fixedCents,
    variableCents: variableShareCents,
    currency,
    usageUnits: roundUsage(consumer.usageUnits),
    usageEventIds: [...consumer.usageEventIds],
    auditFactIds: [...new Set(auditFactIds)],
  };
}

function materializeAllocation({
  resourceId,
  period,
  currency,
  totalCostCents,
  fixedOverheadCents,
  policy,
  ownerPrincipal,
  shares,
  systemOverheadCents,
  systemOverheadReason,
  auditFacts,
  deduplicatedUsageEvents,
}) {
  const orderedShares = shares.sort((left, right) => left.consumerKey.localeCompare(right.consumerKey));
  const systemOverheadBucket =
    systemOverheadCents > 0
      ? {
          costCents: systemOverheadCents,
          currency,
          reason: systemOverheadReason,
          auditFactIds: [`resource-cost:${resourceId}:${period}`],
        }
      : null;
  const shareTotal = orderedShares.reduce((total, share) => total + share.costCents, 0);
  const accountedTotal = shareTotal + (systemOverheadBucket?.costCents ?? 0);
  const payload = {
    schemaVersion: SHARED_COST_SCHEMA_VERSION,
    resourceId,
    period,
    currency,
    totalCostCents,
    fixedOverheadCents,
    policy,
    ownerPrincipal,
    shares: orderedShares,
    systemOverheadBucket,
    deduplicatedUsageEvents: [...deduplicatedUsageEvents].sort(compareDedupedEvents),
    auditFacts: uniqueAuditFacts(auditFacts),
    rollupChecks: {
      sharesSumToTotal: accountedTotal === totalCostCents,
      shareCostCents: shareTotal,
      systemOverheadCents: systemOverheadBucket?.costCents ?? 0,
      unattributedRemainderCents: totalCostCents - accountedTotal,
      denominatorConsumerCount: orderedShares.length,
    },
  };
  if (!payload.rollupChecks.sharesSumToTotal) {
    throw new RangeError("shared cost allocation must exactly reconcile to totalCostCents");
  }
  return {
    ...payload,
    allocationId: sha256(canonicalJson(payload)),
  };
}

function replayUsageEvents(input, resourceId) {
  const events = expectArray(input, "input.usageEvents").map((event, index) =>
    normalizeUsageEvent(event, resourceId, `input.usageEvents[${index}]`),
  );
  const accepted = [];
  const deduplicatedUsageEvents = [];
  const seen = new Map();
  for (const event of events.sort(compareUsageEvents)) {
    if (seen.has(event.idempotencyKey)) {
      deduplicatedUsageEvents.push({
        eventId: event.eventId,
        idempotencyKey: event.idempotencyKey,
        originalEventId: seen.get(event.idempotencyKey),
      });
      continue;
    }
    seen.set(event.idempotencyKey, event.eventId);
    accepted.push(event);
  }
  return { events: accepted, deduplicatedUsageEvents };
}

function normalizeUsageEvent(event, resourceId, fieldName) {
  const source = expectObject(event, fieldName);
  const eventResourceId = optionalString(source.resourceId, `${fieldName}.resourceId`) ?? resourceId;
  if (eventResourceId !== resourceId) {
    throw new RangeError(`${fieldName}.resourceId must match input.resourceId`);
  }
  const eventId = requireString(source.eventId ?? source.id, `${fieldName}.eventId`);
  const consumer = normalizeConsumer(source.consumer, `${fieldName}.consumer`);
  return {
    eventId,
    idempotencyKey: optionalString(source.idempotencyKey, `${fieldName}.idempotencyKey`) ?? eventId,
    seq: requireNonNegativeInteger(source.seq, `${fieldName}.seq`),
    occurredAt: normalizeInstant(source.occurredAt, `${fieldName}.occurredAt`),
    consumer,
    usageUnits: requireNonNegativeNumber(source.usageUnits, `${fieldName}.usageUnits`),
  };
}

function normalizeConsumers(input) {
  return expectArray(input, "input.consumers").map((consumer, index) =>
    normalizeConsumer(consumer, `input.consumers[${index}]`),
  );
}

function normalizeConsumer(input, fieldName) {
  const source = expectObject(input, fieldName);
  const tenantId = requireString(source.tenantId, `${fieldName}.tenantId`);
  const campId = requireString(source.campId, `${fieldName}.campId`);
  const bindleId = requireString(source.bindleId, `${fieldName}.bindleId`);
  const appTenantId = optionalString(source.appTenantId, `${fieldName}.appTenantId`);
  const consumerKey = stableConsumerKey({ tenantId, campId, bindleId, appTenantId });
  return {
    consumerKey,
    tenantId,
    campId,
    bindleId,
    appTenantId,
    registrationEventId:
      optionalString(source.registrationEventId, `${fieldName}.registrationEventId`) ?? `consumer:${consumerKey}`,
    weight: source.weight === undefined ? 1 : requirePositiveNumber(source.weight, `${fieldName}.weight`),
    usageUnits: 0,
    usageEventIds: [],
  };
}

function mergeConsumer(consumerMap, consumer, usageEvent = null) {
  if (!consumerMap.has(consumer.consumerKey)) {
    consumerMap.set(consumer.consumerKey, {
      ...consumer,
      usageEventIds: [],
      usageUnits: 0,
    });
  }
  const existing = consumerMap.get(consumer.consumerKey);
  existing.weight = consumer.weight ?? existing.weight;
  existing.registrationEventId = existing.registrationEventId ?? consumer.registrationEventId;
  if (usageEvent) {
    existing.usageUnits = roundUsage(existing.usageUnits + usageEvent.usageUnits);
    existing.usageEventIds.push(usageEvent.eventId);
  }
}

function allocateCents(totalCents, weightedKeys) {
  if (totalCents === 0) {
    return new Map();
  }
  const entries = weightedKeys
    .map(({ key, weight }) => ({ key, weight: requireNonNegativeNumber(weight, `weight for ${key}`) }))
    .filter((entry) => entry.weight > 0)
    .sort((left, right) => left.key.localeCompare(right.key));
  if (entries.length === 0) {
    throw new RangeError("cannot allocate cents without positive weights");
  }
  const totalWeight = entries.reduce((total, entry) => total + entry.weight, 0);
  const allocated = entries.map((entry) => {
    const exact = (totalCents * entry.weight) / totalWeight;
    const floor = Math.floor(exact);
    return {
      key: entry.key,
      cents: floor,
      remainder: exact - floor,
    };
  });
  let remainderCents = totalCents - allocated.reduce((total, entry) => total + entry.cents, 0);
  for (const entry of [...allocated].sort(compareRemainder)) {
    if (remainderCents <= 0) {
      break;
    }
    entry.cents += 1;
    remainderCents -= 1;
  }
  return new Map(allocated.map((entry) => [entry.key, entry.cents]));
}

function compareRemainder(left, right) {
  const remainderDelta = right.remainder - left.remainder;
  if (remainderDelta !== 0) {
    return remainderDelta;
  }
  return left.key.localeCompare(right.key);
}

function normalizePolicy(input) {
  const source = input === undefined ? { strategy: "usage-share" } : expectObject(input, "input.policy");
  const strategy = requireString(source.strategy ?? "usage-share", "input.policy.strategy");
  if (!SPLIT_STRATEGIES.has(strategy)) {
    throw new TypeError(`input.policy.strategy must be one of ${[...SPLIT_STRATEGIES].join(", ")}`);
  }
  return { strategy };
}

function normalizeOwnerPrincipal(input) {
  const source = input === undefined ? { kind: "platform", principalId: "hobo-platform" } : expectObject(input, "input.ownerPrincipal");
  const kind = requireString(source.kind, "input.ownerPrincipal.kind");
  if (kind === "platform") {
    return { kind, principalId: optionalString(source.principalId, "input.ownerPrincipal.principalId") ?? "hobo-platform" };
  }
  if (kind === "tenant") {
    return { kind, tenantId: requireString(source.tenantId, "input.ownerPrincipal.tenantId") };
  }
  throw new TypeError("input.ownerPrincipal.kind must be platform or tenant");
}

function consumerAuditFacts(consumer) {
  return [
    {
      factId: consumer.registrationEventId,
      kind: "consumer-registration",
      consumerKey: consumer.consumerKey,
      tenantId: consumer.tenantId,
      campId: consumer.campId,
      bindleId: consumer.bindleId,
    },
    ...consumer.usageEventIds.map((eventId) => ({
      factId: eventId,
      kind: "usage",
      consumerKey: consumer.consumerKey,
    })),
  ];
}

function costAuditFacts({ costFactId, fixedFactId, totalCostCents, fixedOverheadCents }) {
  return [
    {
      factId: costFactId,
      kind: "resource-cost",
      totalCostCents,
    },
    fixedFactId
      ? {
          factId: fixedFactId,
          kind: "fixed-overhead",
          fixedOverheadCents,
        }
      : null,
  ].filter(Boolean);
}

function uniqueAuditFacts(facts) {
  const byId = new Map();
  for (const fact of facts) {
    byId.set(fact.factId, fact);
  }
  return [...byId.values()].sort((left, right) => left.factId.localeCompare(right.factId));
}

function stableConsumerKey({ tenantId, campId, bindleId, appTenantId }) {
  return [tenantId, campId, bindleId, appTenantId ?? "_"].join("/");
}

function compareUsageEvents(left, right) {
  return left.seq - right.seq || left.eventId.localeCompare(right.eventId);
}

function compareDedupedEvents(left, right) {
  return left.idempotencyKey.localeCompare(right.idempotencyKey) || left.eventId.localeCompare(right.eventId);
}

function compareConsumers(left, right) {
  return left.consumerKey.localeCompare(right.consumerKey);
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

function expectObject(value, fieldName) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  return value;
}

function expectArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an array`);
  }
  return value;
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

function requireNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${fieldName} must be a non-negative safe integer`);
  }
  return value;
}

function requireNonNegativeNumber(value, fieldName) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${fieldName} must be a non-negative finite number`);
  }
  return value;
}

function requirePositiveNumber(value, fieldName) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${fieldName} must be a positive finite number`);
  }
  return value;
}

function roundUsage(value) {
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
