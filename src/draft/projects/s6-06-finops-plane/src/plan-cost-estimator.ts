import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";
export const PLAN_COST_ESTIMATE_SCHEMA = "hobo.finops.plan-estimate/v1";
export const SHOWBACK_RECONCILE_SCHEMA = "hobo.finops.showback-reconcile/v1";

const EGRESS_TIERS = new Set(["same_region", "cross_region", "internet"]);
const ASSUMPTIONS = Object.freeze([
  "30 day month unless plan.assumptionDays overrides",
  "provider catalog prices are list estimates from cost.json",
  "egress priced by declared connectivity tier",
]);

export function estimatePlanCost(input) {
  const source = expectObject(input, "input");
  const costJson = expectObject(source.costJson, "costJson");
  const plan = expectObject(source.plan, "plan");
  const regions = requireStringArray(plan.regions, "plan.regions");
  if (regions.length === 0) {
    throw new TypeError("plan.regions must not be empty");
  }
  const catalogRegions = requireStringArray(costJson.regions, "costJson.regions");
  for (const region of regions) {
    if (!catalogRegions.includes(region)) {
      throw new RangeError(`plan region missing from cost.json coverage: ${region}`);
    }
  }

  const lineItems = [];
  for (const resource of requireArray(plan.resources, "plan.resources")) {
    lineItems.push(
      priceLine({
        resourceId: requireString(resource.id, "resource.id"),
        dimension: requireString(resource.dimension, "resource.dimension"),
        quantity: requirePositiveNumber(resource.quantityPerMonth, "resource.quantityPerMonth"),
        costJson,
        priceKey: resource.tier ?? resource.priceKey ?? null,
        region: resource.region ?? regions[0],
        planRegions: regions,
      }),
    );
  }

  for (const edge of requireArray(plan.egress ?? [], "plan.egress")) {
    const tier = requireString(edge.tier ?? edge.connectivityTier, "egress.tier");
    if (!EGRESS_TIERS.has(tier)) {
      throw new TypeError(`unsupported egress tier ${tier}`);
    }
    lineItems.push(
      priceLine({
        resourceId: requireString(edge.id, "egress.id"),
        dimension: "egress-gb",
        quantity: requirePositiveNumber(edge.quantityPerMonth, "egress.quantityPerMonth"),
        costJson,
        priceKey: tier,
        region: edge.region ?? regions[0],
        planRegions: regions,
      }),
    );
  }

  const projectedMonthlyUsd = roundUsd(
    lineItems.reduce((total, item) => total + item.lineCostUsd, 0),
  );

  return {
    schemaVersion: PLAN_COST_ESTIMATE_SCHEMA,
    projectedMonthlyUsd,
    currency: readCurrency(costJson),
    lineItems,
    assumptions: [...ASSUMPTIONS],
    regions,
  };
}

export function withinCostTolerance(estimateUsd, actualUsd, toleranceFraction) {
  const tolerance = requireFraction(toleranceFraction, "toleranceFraction");
  const actual = requireNonNegativeNumber(actualUsd, "actualUsd");
  const estimate = requireNonNegativeNumber(estimateUsd, "estimateUsd");
  if (actual === 0) {
    return estimate === 0;
  }
  const delta = Math.abs(estimate - actual) / actual;
  return delta <= tolerance;
}

function priceLine({ resourceId, dimension, quantity, costJson, priceKey, region, planRegions }) {
  if (!planRegions.includes(region)) {
    throw new RangeError(`resource region ${region} must be declared in plan.regions`);
  }
  const unitPriceUsd = resolveUnitPrice(costJson, dimension, priceKey);
  const lineCostUsd = roundUsd(quantity * unitPriceUsd);
  return {
    resourceId,
    dimension,
    quantity,
    unitPriceUsd,
    lineCostUsd,
  };
}

function resolveUnitPrice(costJson, dimension, priceKey) {
  const unitPrices = expectObject(costJson.unitPrices, "costJson.unitPrices");
  const price = unitPrices[dimension];
  if (price === undefined) {
    throw new RangeError(`missing unit price for dimension ${dimension}`);
  }
  if (isJsonNumber(price)) {
    return price;
  }
  const tree = expectObject(price, `unitPrices.${dimension}`);
  const key = priceKey ?? "same_region";
  if (!(key in tree)) {
    throw new RangeError(`missing tier price ${key} for dimension ${dimension}`);
  }
  return requireNonNegativeNumber(tree[key], `unitPrices.${dimension}.${key}`);
}

function readCurrency(costJson) {
  const currency = requireString(costJson.currency, "costJson.currency");
  if (currency !== "USD") {
    throw new TypeError("only USD catalog supported in this POC");
  }
  return currency;
}

function roundUsd(value) {
  return Math.round(value * 100) / 100;
}

function expectObject(value, label) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

function requireString(value, label) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value, label) {
  return requireArray(value, label).map((entry, index) => requireString(entry, `${label}[${index}]`));
}

function requirePositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive number`);
  }
  return number;
}

function requireNonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative number`);
  }
  return number;
}

function requireFraction(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new TypeError(`${label} must be between 0 and 1`);
  }
  return number;
}
