import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const COST_JSON_SCHEMA_VERSION = "hobo.cost/v1";
export const COST_SIGNAL_EVENT_SCHEMA_VERSION = "hobo.cost-signal-event/v1";
export const CREDIT_LEDGER_VIEW_SCHEMA_VERSION = "hobo.credit-ledger-view/v1";

export const METERING_DIMENSIONS = Object.freeze([
  "control-plane-ops",
  "runtime-compute-seconds",
  "storage-gb",
  "egress-gb",
  "generation-runs",
]);

const METERING_DIMENSION_SET = new Set(METERING_DIMENSIONS);
const COST_SIGNAL_TYPES = new Set([
  "meter.UsageRecorded",
  "spend.Recorded",
  "spend.CircuitTripped",
  "spend.CircuitReset",
  "spend.DegradationRequired",
  "spend.DegradationApplied",
  "spend.DegradationRolledBack",
  "credit.Registered",
  "credit.Reset",
  "credit.Exhausted",
  "credit.BudgetCapSet",
]);
const ISO_DURATION = /^P(?=\d|T)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;
const SHA256_REF = /^sha256:[a-f0-9]{64}$/;
const DEGRADATION_TIERS = new Set(["nominal", "reduced", "minimal"]);

export function parseCostJson(input) {
  const costJson = requireObject(input, "costJson");
  assertEqual(costJson.schemaVersion, COST_JSON_SCHEMA_VERSION, "costJson.schemaVersion");
  const providerId = requireString(costJson.providerId, "costJson.providerId");
  const currency = requireCurrency(costJson.currency, "costJson.currency");
  const regions = requireUniqueStrings(costJson.regions, "costJson.regions");
  const unitPrices = requireObject(costJson.unitPrices, "costJson.unitPrices");
  if (Object.keys(unitPrices).length === 0) {
    throw new TypeError("costJson.unitPrices must not be empty");
  }

  const tiers = normalizeTiers(costJson.tiers ?? {});
  const normalizedUnitPrices = {};
  for (const [unitKey, price] of Object.entries(unitPrices)) {
    requireString(unitKey, "costJson.unitPrices key");
    normalizedUnitPrices[unitKey] = normalizePriceTree(price, {
      path: `unitPrices.${unitKey}`,
      unitKey,
      declaredTiers: tiers[unitKey],
      declaredRegions: regions,
    });
  }

  const freeTier = normalizeFreeTier(costJson.freeTier ?? {}, normalizedUnitPrices);

  return {
    schemaVersion: COST_JSON_SCHEMA_VERSION,
    providerId,
    currency,
    regions,
    tiers,
    unitPrices: normalizedUnitPrices,
    freeTier,
  };
}

export function validateCostCatalogSet(catalogs) {
  if (!Array.isArray(catalogs) || catalogs.length === 0) {
    throw new TypeError("catalogs must be a non-empty array");
  }

  const parsed = catalogs.map(parseCostJson);
  const currencies = new Set(parsed.map((catalog) => catalog.currency));
  if (currencies.size > 1) {
    throw new TypeError(`mixed currencies across provider cost catalogs: ${[...currencies].join(", ")}`);
  }
  return parsed;
}

export function validatePlanCostCoverage(costJson, plan) {
  const catalog = parseCostJson(costJson);
  const planRegions = requireUniqueStrings(plan?.regions, "plan.regions");
  const missingRegions = planRegions.filter((region) => !catalog.regions.includes(region));
  if (missingRegions.length > 0) {
    throw new RangeError(`missing region in cost.json: ${missingRegions.join(", ")}`);
  }
  return { providerId: catalog.providerId, coveredRegions: planRegions };
}

export function parseCostSignalEvent(input) {
  const event = requireObject(input, "event");
  assertEqual(event.schemaVersion, COST_SIGNAL_EVENT_SCHEMA_VERSION, "event.schemaVersion");
  const type = requireString(event.type, "event.type");
  if (!COST_SIGNAL_TYPES.has(type)) {
    throw new TypeError(`unsupported cost signal event type ${type}`);
  }

  const base = {
    schemaVersion: COST_SIGNAL_EVENT_SCHEMA_VERSION,
    type,
    seq: requireNonNegativeInteger(event.seq, "event.seq"),
    time: normalizeInstant(event.time, "event.time"),
  };

  if (type === "meter.UsageRecorded") {
    return { ...base, ...normalizeUsageEvent(event) };
  }
  if (type === "spend.Recorded") {
    return {
      ...base,
      ...normalizeUsageEvent(event),
      amount: requireNonNegativeNumber(event.amount, "event.amount"),
      currency: requireCurrency(event.currency, "event.currency"),
      spendVelocityPerHour: requireNonNegativeNumber(
        event.spendVelocityPerHour,
        "event.spendVelocityPerHour",
      ),
    };
  }
  if (type === "spend.CircuitTripped") {
    return { ...base, ...normalizeSpendCircuitTripEvent(event) };
  }
  if (type === "spend.CircuitReset") {
    return { ...base, ...normalizeSpendCircuitResetEvent(event) };
  }
  if (type === "spend.DegradationRequired") {
    return { ...base, ...normalizeSpendDegradationEvent(event) };
  }
  if (type === "spend.DegradationApplied") {
    return { ...base, ...normalizeSpendDegradationAppliedEvent(event) };
  }
  if (type === "spend.DegradationRolledBack") {
    return { ...base, ...normalizeSpendDegradationRolledBackEvent(event) };
  }
  if (type === "credit.Registered" || type === "credit.Reset") {
    return { ...base, ...normalizeCreditWindowEvent(event) };
  }
  if (type === "credit.Exhausted") {
    return {
      ...base,
      providerId: requireString(event.providerId, "event.providerId"),
      dimension: requireMeteringDimension(event.dimension, "event.dimension"),
      creditId: requireString(event.creditId, "event.creditId"),
    };
  }
  if (type === "credit.BudgetCapSet") {
    return {
      ...base,
      providerId: requireString(event.providerId, "event.providerId"),
      dimension: requireMeteringDimension(event.dimension, "event.dimension"),
      budgetCap: requireNonNegativeNumber(event.budgetCap, "event.budgetCap"),
      currency: requireCurrency(event.currency, "event.currency"),
    };
  }

  return base;
}

export function serializeCostSignalEvent(event) {
  return canonicalJson(parseCostSignalEvent(event));
}

export function serializeCreditLedgerView(input) {
  const snapshot = requireObject(input, "snapshot");
  assertEqual(snapshot.schemaVersion, CREDIT_LEDGER_VIEW_SCHEMA_VERSION, "snapshot.schemaVersion");
  assertEqual(snapshot.view, "CreditLedgerView", "snapshot.view");

  const normalized = {
    schemaVersion: CREDIT_LEDGER_VIEW_SCHEMA_VERSION,
    view: "CreditLedgerView",
    seq: requireNonNegativeInteger(snapshot.seq, "snapshot.seq"),
    asOf: normalizeInstant(snapshot.asOf, "snapshot.asOf"),
    accounts: normalizeLedgerAccounts(snapshot.accounts),
  };

  const digest = `sha256:${sha256(canonicalJson(normalized))}`;
  if (isJsonString(snapshot.digest) && snapshot.digest !== digest) {
    if (!SHA256_REF.test(snapshot.digest)) {
      throw new TypeError("snapshot.digest must be a sha256 reference");
    }
    throw new TypeError("snapshot.digest does not match snapshot contents");
  }

  const withDigest = { ...normalized, digest };
  return {
    ...withDigest,
    serialized: canonicalJson(withDigest),
  };
}

export function splitMeteringPeriodByResetWindow(period, resetWindow) {
  const periodStart = normalizeInstant(period?.start, "period.start");
  const periodEnd = normalizeInstant(period?.end, "period.end");
  const resetStart = normalizeInstant(resetWindow?.start, "resetWindow.start");
  const resetEnd = normalizeInstant(resetWindow?.end, "resetWindow.end");
  assertBefore(periodStart, periodEnd, "period");
  assertBefore(resetStart, resetEnd, "resetWindow");

  if (Date.parse(resetStart) > Date.parse(periodStart) && Date.parse(resetStart) < Date.parse(periodEnd)) {
    return [
      { start: periodStart, end: resetStart, resetWindow: "previous" },
      { start: resetStart, end: periodEnd, resetWindow: "current" },
    ];
  }

  const insideReset =
    Date.parse(periodStart) >= Date.parse(resetStart) && Date.parse(periodEnd) <= Date.parse(resetEnd);
  return [{ start: periodStart, end: periodEnd, resetWindow: insideReset ? "current" : "previous" }];
}

function normalizeUsageEvent(event) {
  return {
    tenantId: requireString(event.tenantId, "event.tenantId"),
    campId: requireString(event.campId, "event.campId"),
    bindleId: requireString(event.bindleId, "event.bindleId"),
    providerId: requireString(event.providerId, "event.providerId"),
    dimension: requireMeteringDimension(event.dimension, "event.dimension"),
    quantity: requirePositiveNumber(event.quantity, "event.quantity"),
    unit: requireString(event.unit, "event.unit"),
  };
}

function normalizeSpendCircuitTripEvent(event) {
  return {
    ...normalizeSpendScope(event),
    threshold: requirePositiveNumber(event.threshold, "event.threshold"),
    spendVelocityPerHour: requireNonNegativeNumber(
      event.spendVelocityPerHour,
      "event.spendVelocityPerHour",
    ),
    currency: requireCurrency(event.currency, "event.currency"),
    reason: requireString(event.reason, "event.reason"),
  };
}

function normalizeSpendCircuitResetEvent(event) {
  return {
    ...normalizeSpendScope(event),
    circuitId: requireString(event.circuitId, "event.circuitId"),
    acknowledgedBy: requireString(event.acknowledgedBy, "event.acknowledgedBy"),
  };
}

function normalizeSpendDegradationEvent(event) {
  const fromTier = requireDegradationTier(event.fromTier, "event.fromTier");
  const toTier = requireDegradationTier(event.toTier, "event.toTier");
  if (fromTier === toTier) {
    throw new RangeError("event.toTier must differ from event.fromTier");
  }
  return {
    ...normalizeSpendScope(event),
    fromTier,
    toTier,
    budgetFraction: requirePositiveNumber(event.budgetFraction, "event.budgetFraction"),
    spendVelocityPerHour: requireNonNegativeNumber(
      event.spendVelocityPerHour,
      "event.spendVelocityPerHour",
    ),
    currency: requireCurrency(event.currency, "event.currency"),
  };
}

function normalizeSpendDegradationAppliedEvent(event) {
  return {
    ...normalizeSpendScope(event),
    tier: requireDegradationTier(event.tier, "event.tier"),
    step: requireString(event.step, "event.step"),
    appliedBy: requireString(event.appliedBy, "event.appliedBy"),
  };
}

function normalizeSpendDegradationRolledBackEvent(event) {
  const fromTier = requireDegradationTier(event.fromTier, "event.fromTier");
  const toTier = requireDegradationTier(event.toTier, "event.toTier");
  if (fromTier === toTier) {
    throw new RangeError("event.toTier must differ from event.fromTier");
  }
  return {
    ...normalizeSpendScope(event),
    fromTier,
    toTier,
    reason: requireString(event.reason, "event.reason"),
  };
}

function normalizeSpendScope(event) {
  return {
    tenantId: requireString(event.tenantId, "event.tenantId"),
    campId: requireString(event.campId, "event.campId"),
    bindleId: requireString(event.bindleId, "event.bindleId"),
  };
}

function normalizeCreditWindowEvent(event) {
  const resetWindowStart = normalizeInstant(event.resetWindowStart, "event.resetWindowStart");
  const resetWindowEnd = normalizeInstant(event.resetWindowEnd, "event.resetWindowEnd");
  assertBefore(resetWindowStart, resetWindowEnd, "event reset window");
  return {
    providerId: requireString(event.providerId, "event.providerId"),
    dimension: requireMeteringDimension(event.dimension, "event.dimension"),
    creditId: requireString(event.creditId, "event.creditId"),
    amount: requirePositiveNumber(event.amount, "event.amount"),
    currency: requireCurrency(event.currency, "event.currency"),
    resetWindowStart,
    resetWindowEnd,
  };
}

function normalizeLedgerAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new TypeError("snapshot.accounts must be a non-empty array");
  }
  return accounts
    .map((account, index) => {
      const normalized = {
        providerId: requireString(account?.providerId, `snapshot.accounts[${index}].providerId`),
        dimension: requireMeteringDimension(account?.dimension, `snapshot.accounts[${index}].dimension`),
        currency: requireCurrency(account?.currency, `snapshot.accounts[${index}].currency`),
        freeAllotment: requireNonNegativeNumber(
          account?.freeAllotment,
          `snapshot.accounts[${index}].freeAllotment`,
        ),
        consumed: requireNonNegativeNumber(account?.consumed, `snapshot.accounts[${index}].consumed`),
        freeHeadroom: requireNonNegativeNumber(
          account?.freeHeadroom,
          `snapshot.accounts[${index}].freeHeadroom`,
        ),
        spendToDate: requireNonNegativeNumber(
          account?.spendToDate,
          `snapshot.accounts[${index}].spendToDate`,
        ),
        resetWindowStart: normalizeInstant(
          account?.resetWindowStart,
          `snapshot.accounts[${index}].resetWindowStart`,
        ),
        resetWindowEnd: normalizeInstant(
          account?.resetWindowEnd,
          `snapshot.accounts[${index}].resetWindowEnd`,
        ),
      };
      assertBefore(normalized.resetWindowStart, normalized.resetWindowEnd, "snapshot account reset window");
      if (account.budgetCap !== undefined) {
        normalized.budgetCap = requireNonNegativeNumber(
          account.budgetCap,
          `snapshot.accounts[${index}].budgetCap`,
        );
      }
      return normalized;
    })
    .sort((left, right) => {
      const provider = left.providerId.localeCompare(right.providerId);
      return provider || left.dimension.localeCompare(right.dimension);
    });
}

function normalizeTiers(tiers) {
  const tierObject = requireObject(tiers, "costJson.tiers");
  const normalized = {};
  for (const [unitKey, entries] of Object.entries(tierObject)) {
    requireString(unitKey, "costJson.tiers key");
    normalized[unitKey] = requireUniqueStrings(entries, `costJson.tiers.${unitKey}`);
  }
  return normalized;
}

function normalizeFreeTier(freeTier, unitPrices) {
  const freeTierObject = requireObject(freeTier, "costJson.freeTier");
  const normalized = {};
  for (const [unitKey, entry] of Object.entries(freeTierObject)) {
    if (!(unitKey in unitPrices)) {
      throw new TypeError(`freeTier references unknown unit price ${unitKey}`);
    }
    const freeTierEntry = requireObject(entry, `costJson.freeTier.${unitKey}`);
    const amount = requirePositiveNumber(freeTierEntry.amount, `costJson.freeTier.${unitKey}.amount`);
    const resetWindow = requireString(
      freeTierEntry.resetWindow,
      `costJson.freeTier.${unitKey}.resetWindow`,
    );
    if (!ISO_DURATION.test(resetWindow)) {
      throw new TypeError(`costJson.freeTier.${unitKey}.resetWindow must be an ISO-8601 duration`);
    }
    normalized[unitKey] = { amount, resetWindow };
  }
  return normalized;
}

function normalizePriceTree(value, { path, unitKey, declaredTiers, declaredRegions }) {
  if (Number.isFinite(value)) {
    return validateUnitPrice(value, path);
  }
  const priceObject = requireObject(value, path);
  const normalized = {};
  const regionSet = declaredRegions ? new Set(declaredRegions) : undefined;
  for (const [key, entry] of Object.entries(priceObject)) {
    if (declaredTiers && !declaredTiers.includes(key)) {
      throw new RangeError(`unknown tier ${key} for ${unitKey}`);
    }
    if (!declaredTiers && regionSet && !regionSet.has(key)) {
      throw new RangeError(`unknown region ${key} for ${unitKey}`);
    }
    normalized[key] = normalizePriceTree(entry, {
      path: `${path}.${key}`,
      unitKey,
      declaredTiers: undefined,
      declaredRegions: declaredTiers ? declaredRegions : undefined,
    });
  }
  return normalized;
}

function validateUnitPrice(value, path) {
  if (value < 0) {
    throw new RangeError(`negative unit price at ${path}`);
  }
  if (value === 0 && path !== "unitPrices.egress-gb.same-region") {
    throw new RangeError(`zero unit price at ${path}`);
  }
  return value;
}

function requireObject(value, fieldName) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  return value;
}

function requireString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function requireUniqueStrings(values, fieldName) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string array`);
  }
  const normalized = values.map((value, index) => requireString(value, `${fieldName}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${fieldName} must not contain duplicates`);
  }
  return normalized;
}

function requireCurrency(value, fieldName) {
  const currency = requireString(value, fieldName);
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError(`${fieldName} must be an ISO-4217 currency code`);
  }
  return currency;
}

function requirePositiveNumber(value, fieldName) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${fieldName} must be greater than 0`);
  }
  return value;
}

function requireNonNegativeNumber(value, fieldName) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${fieldName} must be a non-negative number`);
  }
  return value;
}

function requireNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function requireMeteringDimension(value, fieldName) {
  const dimension = requireString(value, fieldName);
  if (!METERING_DIMENSION_SET.has(dimension)) {
    throw new TypeError(`${fieldName} must be one of ${METERING_DIMENSIONS.join(", ")}`);
  }
  return dimension;
}

function requireDegradationTier(value, fieldName) {
  const tier = requireString(value, fieldName);
  if (!DEGRADATION_TIERS.has(tier)) {
    throw new TypeError(`${fieldName} must be one of ${[...DEGRADATION_TIERS].join(", ")}`);
  }
  return tier;
}

function normalizeInstant(value, fieldName) {
  const instant = requireString(value, fieldName);
  const timestamp = Date.parse(instant);
  if (Number.isNaN(timestamp)) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 instant`);
  }
  return new Date(timestamp).toISOString();
}

function assertEqual(actual, expected, fieldName) {
  if (actual !== expected) {
    throw new TypeError(`${fieldName} must be ${expected}`);
  }
}

function assertBefore(start, end, label) {
  if (Date.parse(start) >= Date.parse(end)) {
    throw new RangeError(`${label} start must be before end`);
  }
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
