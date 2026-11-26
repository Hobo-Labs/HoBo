import { snapshotMeteringView } from "../../../technical-proofs/metering-view-projection-contract/src/metering-view.js";
import { createShowbackReport } from "../../../technical-proofs/showback-attribution-contract/src/showback-attribution.js";

import { SHOWBACK_RECONCILE_SCHEMA } from "./plan-cost-estimator.js";
import { isJsonString, isJsonObject } from "./json.js";


export function projectShowbackFromEvents(input) {
  const source = expectObject(input, "input");
  const events = requireArray(source.events, "events");
  const seq = requireNonNegativeInteger(source.seq ?? maxSeq(events), "seq");
  const costCatalog = normalizeCostCatalog(source.costCatalog);
  const displayNames = source.displayNames ?? {};

  const meteringView = snapshotMeteringView(events, { seq, costCatalog });
  const showback = createShowbackReport({
    meteringView,
    costCatalog,
    displayNames,
  });

  return {
    meteringView,
    showback,
    tenantRows: showback.tenants,
    campRows: showback.camps,
    bindleRows: showback.bindles,
  };
}

export function reconcileShowbackProjection(input) {
  const projection = projectShowbackFromEvents(input);
  const meteringTotalUsd = roundUsd(projection.meteringView.totalCost);
  const showbackTotalUsd = roundUsd(projection.showback.totalCost);
  const reconciled = meteringTotalUsd === showbackTotalUsd;

  if (!reconciled) {
    throw new RangeError(
      `showback total ${showbackTotalUsd} must match MeteringView total ${meteringTotalUsd}`,
    );
  }

  return {
    schemaVersion: SHOWBACK_RECONCILE_SCHEMA,
    meteringTotalUsd,
    showbackTotalUsd,
    reconciled,
    rows: summarizeRows(projection.showback),
  };
}

function summarizeRows(showback) {
  return ["tenants", "camps", "bindles"].flatMap((level) =>
    (showback[level] ?? []).map((row) => ({
      kind: row.kind,
      id: row.id,
      costUsd: roundUsd(row.totalCost),
    })),
  );
}

function normalizeCostCatalog(costCatalog) {
  const catalog = expectObject(costCatalog, "costCatalog");
  return {
    currency: requireString(catalog.currency, "costCatalog.currency"),
    unitPrices: expectObject(catalog.unitPrices, "costCatalog.unitPrices"),
  };
}

function maxSeq(events) {
  return events.reduce((max, event) => Math.max(max, Number(event.seq ?? 0)), 0);
}

function roundUsd(value) {
  return Math.round(Number(value) * 100) / 100;
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

function requireNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return number;
}
