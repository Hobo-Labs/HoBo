export const SHOWBACK_SCHEMA_VERSION = "hobo.showback/v1";

const LEVELS = {
  tenant: "tenants",
  camp: "camps",
  bindle: "bindles",
  run: "runs",
  agent: "agents",
  team: "teams",
};

export function createShowbackReport(input) {
  const source = expectObject(input, "input");
  const meteringView = normalizeMeteringView(source.meteringView);
  const costCatalog = normalizeCostCatalog(source.costCatalog);
  if (costCatalog.currency !== meteringView.currency) {
    throw new TypeError("input.costCatalog.currency must match MeteringView currency");
  }
  const displayNames = normalizeDisplayNames(source.displayNames);
  const meteringAttributionGaps = normalizeAttributionGaps(meteringView.attributionGaps);
  const maps = Object.fromEntries(Object.values(LEVELS).map((level) => [level, new Map()]));
  const attributionRules = [];
  const deferredAllocations = [];

  for (const event of meteringView.__events) {
    const eventId = requireString(event.id, "event.id");
    const gap = meteringAttributionGaps.get(eventId);
    if (gap) {
      attributionRules.push({
        eventId,
        rule: gap.reason,
        resolution: "exclude from showback attribution until owning principal is corrected",
      });
      continue;
    }
    const owner = normalizeOwner(event.owner);
    const cost = eventCost(event, costCatalog);
    const counter = {
      eventId,
      dimension: requireString(event.dimension, "event.dimension"),
      quantity: requirePositiveNumber(event.quantity, "event.quantity"),
      cost,
      currency: costCatalog.currency,
      owner,
    };
    const sharedBindleIds = normalizeSharedBindles(owner.sharedBindleIds);
    const deferBindle = sharedBindleIds.length > 1;

    addRow(maps.tenants, {
      kind: "tenant",
      id: owner.tenantId,
      displayName: displayNames.tenants[owner.tenantId],
      counter,
    });
    addRow(maps.camps, {
      kind: "camp",
      id: `${owner.tenantId}/${owner.campId}`,
      displayName: displayNames.camps[`${owner.tenantId}/${owner.campId}`],
      counter,
    });

    if (deferBindle) {
      deferredAllocations.push({
        eventId: counter.eventId,
        cost,
        reason: "shared-resource-attribution-deferred",
        bindleIds: sharedBindleIds,
      });
    } else {
      addRow(maps.bindles, {
        kind: "bindle",
        id: bindleKey(owner),
        displayName: displayNames.bindles[bindleKey(owner)],
        counter,
      });
      if (owner.runId) {
        addRow(maps.runs, {
          kind: "run",
          id: runKey(owner),
          displayName: displayNames.runs[runKey(owner)],
          source: pickSource(owner),
          counter,
        });
      }
    }

    if (owner.agentId) {
      addRow(maps.agents, {
        kind: "agent",
        id: `${owner.tenantId}/${owner.agentId}`,
        displayName: displayNames.agents[`${owner.tenantId}/${owner.agentId}`],
        counter,
      });
    }
    if (owner.teamId) {
      addRow(maps.teams, {
        kind: "team",
        id: `${owner.tenantId}/${owner.teamId}`,
        displayName: displayNames.teams[`${owner.tenantId}/${owner.teamId}`],
        counter,
      });
    }
    if (!owner.agentId && !owner.teamId) {
      attributionRules.push({
        eventId: counter.eventId,
        rule: "agent-or-team-ambiguous",
        resolution: "attribute to tenant/camp/bindle/run only",
      });
    }
  }

  const levels = {
    tenants: materializeRows(maps.tenants, tenantParentKey),
    camps: materializeRows(maps.camps, tenantParentKey),
    bindles: materializeRows(maps.bindles, campParentKey),
    runs: materializeRows(maps.runs, bindleParentKey),
    agents: materializeRows(maps.agents, tenantParentKey),
    teams: materializeRows(maps.teams, tenantParentKey),
  };
  const tenantCost = sum(levels.tenants);
  if (!sameMoney(tenantCost, meteringView.totalCost)) {
    throw new RangeError("recomputed showback total must match MeteringView totalCost");
  }

  return {
    schemaVersion: SHOWBACK_SCHEMA_VERSION,
    source: {
      meteringViewSeq: meteringView.seq,
      meteringViewDigest: meteringView.digest,
      currency: meteringView.currency,
    },
    totalCost: meteringView.totalCost,
    presentationCost: roundPresentation(meteringView.totalCost),
    levels,
    attributionRules,
    deferredAllocations,
    rollupChecks: {
      tenantToCampBalanced: sameMoney(tenantCost, sum(levels.camps)),
      tenantToBindleBalanced: sameMoney(tenantCost, sum(levels.bindles) + sumDeferred(deferredAllocations)),
      tenantToRunBalanced: sameMoney(tenantCost, sum(levels.runs) + sumDeferred(deferredAllocations)),
    },
  };
}

export function selectShowbackRow(report, selector) {
  const source = expectObject(selector, "selector");
  const level = LEVELS[requireString(source.kind, "selector.kind")];
  if (!level) {
    throw new TypeError(`selector.kind must be one of ${Object.keys(LEVELS).join(", ")}`);
  }
  const id = requireString(source.id, "selector.id");
  const row = normalizeReport(report).levels[level].find((candidate) => candidate.id === id);
  if (!row) {
    throw new RangeError(`missing showback ${source.kind} row ${id}`);
  }
  return row;
}

export function annotateRunInspector(report, inspector) {
  const normalized = normalizeReport(report);
  const target = expectObject(inspector, "inspector");
  if (!Array.isArray(target.runs)) {
    throw new TypeError("inspector.runs must be an array");
  }
  return {
    ...target,
    runs: target.runs.map((run) => {
      const row = findInspectorRunRow(normalized.levels.runs, run);
      if (!row) {
        return { ...run };
      }
      return {
        ...run,
        costAnnotation: runCostAnnotation(normalized, row),
      };
    }),
  };
}

function findInspectorRunRow(rows, run) {
  const target = expectObject(run, "inspector.runs[]");
  const directId = optionalString(target.showbackRunId) ?? optionalString(target.showbackRowId);
  if (directId) {
    return rows.find((candidate) => candidate.id === directId) ?? null;
  }
  const runId = requireString(target.runId, "inspector.runs[].runId");
  const fullKey = inspectorRunKey(target);
  if (fullKey) {
    return rows.find((candidate) => candidate.id === fullKey) ?? null;
  }
  const matches = rows.filter((candidate) => candidate.source?.runId === runId);
  return matches.length === 1 ? matches[0] : null;
}

function runCostAnnotation(report, row) {
  return {
    cost: row.cost,
    presentationCost: row.presentationCost,
    currency: row.currency,
    meteringViewSeq: report.source.meteringViewSeq,
    meteringViewDigest: report.source.meteringViewDigest,
    sourceEventIds: row.sourceEventIds,
  };
}

function addRow(rows, { kind, id, displayName, source, counter }) {
  if (!rows.has(id)) {
    rows.set(id, {
      kind,
      id,
      displayName,
      source,
      currency: counter.currency,
      quantityByDimension: {},
      costByDimension: {},
      cost: 0,
      sourceEventIds: [],
    });
  }
  const row = rows.get(id);
  row.quantityByDimension[counter.dimension] = roundQuantity(
    (row.quantityByDimension[counter.dimension] ?? 0) + counter.quantity,
  );
  row.costByDimension[counter.dimension] = roundCost(
    (row.costByDimension[counter.dimension] ?? 0) + counter.cost,
  );
  row.cost = roundCost(row.cost + counter.cost);
  row.sourceEventIds.push(counter.eventId);
}

function materializeRows(rows, groupBy = () => "__all__") {
  const materialized = [...rows.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => ({
      ...row,
      quantityByDimension: sortObject(row.quantityByDimension),
      costByDimension: sortObject(row.costByDimension),
      sourceEventIds: [...new Set(row.sourceEventIds)],
    }));
  for (const group of groupRows(materialized, groupBy).values()) {
    attachPresentationCosts(group, sum(group));
  }
  return materialized;
}

function groupRows(rows, groupBy) {
  const groups = new Map();
  for (const row of rows) {
    const key = groupBy(row);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }
  return groups;
}

function attachPresentationCosts(rows, parentTotal) {
  const targetCents = toCents(parentTotal);
  const floors = rows.map((row) => {
    const exactCents = row.cost * 100;
    return {
      id: row.id,
      floor: Math.floor(exactCents),
      remainder: exactCents - Math.floor(exactCents),
    };
  });
  let remaining = targetCents - floors.reduce((total, entry) => total + entry.floor, 0);
  const extras = new Set(
    [...floors]
      .sort((left, right) => right.remainder - left.remainder || left.id.localeCompare(right.id))
      .slice(0, Math.max(0, remaining))
      .map((entry) => entry.id),
  );

  for (const row of rows) {
    const floor = floors.find((entry) => entry.id === row.id).floor;
    row.presentationCost = Number(((floor + (extras.has(row.id) && remaining-- > 0 ? 1 : 0)) / 100).toFixed(2));
  }
}

function eventCost(event, costCatalog) {
  const price = costCatalog.unitPrices[requireString(event.dimension, "event.dimension")];
  if (isNumber(price)) {
    if (price < 0) {
      throw new RangeError(`unit price for ${event.dimension} must be non-negative`);
    }
    return roundCost(requirePositiveNumber(event.quantity, "event.quantity") * price);
  }
  if (isObjectRecord(price)) {
    const key = requireString(event.priceKey, "event.priceKey");
    const keyed = price[key];
    if (!Number.isFinite(keyed) || keyed < 0) {
      throw new RangeError(`unit price for ${event.dimension}/${key} must be non-negative`);
    }
    return roundCost(requirePositiveNumber(event.quantity, "event.quantity") * keyed);
  }
  throw new RangeError(`missing unit price for ${event.dimension}`);
}

function normalizeMeteringView(input) {
  const view = expectObject(input, "input.meteringView");
  if (view.view !== "MeteringView") {
    throw new TypeError("input.meteringView must be a MeteringView snapshot");
  }
  if (!Array.isArray(view.__events)) {
    throw new TypeError("input.meteringView must retain source events for showback traceability");
  }
  return {
    ...view,
    __events: view.__events,
    seq: requireNonNegativeInteger(view.seq, "input.meteringView.seq"),
    digest: requireString(view.digest, "input.meteringView.digest"),
    currency: requireString(view.currency, "input.meteringView.currency"),
    totalCost: requireNonNegativeNumber(view.totalCost, "input.meteringView.totalCost"),
  };
}

function normalizeReport(input) {
  const report = expectObject(input, "report");
  if (report.schemaVersion !== SHOWBACK_SCHEMA_VERSION) {
    throw new TypeError(`report.schemaVersion must be ${SHOWBACK_SCHEMA_VERSION}`);
  }
  return report;
}

function normalizeCostCatalog(input) {
  const costCatalog = expectObject(input, "input.costCatalog");
  return {
    currency: requireString(costCatalog.currency, "input.costCatalog.currency"),
    unitPrices: expectObject(costCatalog.unitPrices, "input.costCatalog.unitPrices"),
  };
}

function normalizeAttributionGaps(input = []) {
  if (!Array.isArray(input)) {
    throw new TypeError("input.meteringView.attributionGaps must be an array");
  }
  return new Map(
    input.map((gap, index) => {
      const entry = expectObject(gap, `input.meteringView.attributionGaps[${index}]`);
      return [
        requireString(entry.eventId, `input.meteringView.attributionGaps[${index}].eventId`),
        {
          reason: requireString(entry.reason, `input.meteringView.attributionGaps[${index}].reason`),
        },
      ];
    }),
  );
}

function normalizeOwner(input) {
  const owner = expectObject(input, "event.owner");
  return {
    tenantId: requireString(owner.tenantId, "event.owner.tenantId"),
    campId: requireString(owner.campId, "event.owner.campId"),
    bindleId: requireString(owner.bindleId, "event.owner.bindleId"),
    runId: optionalString(owner.runId),
    agentId: optionalString(owner.agentId),
    teamId: optionalString(owner.teamId),
    sharedBindleIds: owner.sharedBindleIds,
  };
}

function normalizeSharedBindles(input) {
  if (input === undefined || input === null) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new TypeError("event.owner.sharedBindleIds must be an array");
  }
  return [...new Set(input.map((value, index) => requireString(value, `event.owner.sharedBindleIds[${index}]`)))]
    .sort();
}

function normalizeDisplayNames(input = {}) {
  const source = isObjectRecord(input) ? input : {};
  return {
    tenants: objectOrEmpty(source.tenants),
    camps: objectOrEmpty(source.camps),
    bindles: objectOrEmpty(source.bindles),
    runs: objectOrEmpty(source.runs),
    agents: objectOrEmpty(source.agents),
    teams: objectOrEmpty(source.teams),
  };
}

function objectOrEmpty(input) {
  if (input === undefined || input === null) {
    return {};
  }
  return expectObject(input, "displayNames entry");
}

function pickSource(owner) {
  return {
    tenantId: owner.tenantId,
    campId: owner.campId,
    bindleId: owner.bindleId,
    runId: owner.runId,
  };
}

function bindleKey(owner) {
  return `${owner.tenantId}/${owner.campId}/${owner.bindleId}`;
}

function runKey(owner) {
  return `${bindleKey(owner)}/${owner.runId}`;
}

function inspectorRunKey(run) {
  const tenantId = optionalString(run.tenantId);
  const campId = optionalString(run.campId);
  const bindleId = optionalString(run.bindleId);
  if (!tenantId || !campId || !bindleId) {
    return null;
  }
  return `${tenantId}/${campId}/${bindleId}/${run.runId}`;
}

function tenantParentKey(row) {
  return row.id.split("/").slice(0, 1).join("/");
}

function campParentKey(row) {
  return row.id.split("/").slice(0, 2).join("/");
}

function bindleParentKey(row) {
  return row.id.split("/").slice(0, 3).join("/");
}

function sum(rows) {
  return roundCost(rows.reduce((total, row) => total + row.cost, 0));
}

function sumDeferred(rows) {
  return roundCost(rows.reduce((total, row) => total + row.cost, 0));
}

function sameMoney(left, right) {
  return roundCost(left) === roundCost(right);
}

function sortObject(input) {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}

function expectObject(input, fieldName) {
  if (!isObjectRecord(input)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  return input;
}

function requireString(input, fieldName) {
  if (!isString(input) || input.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return input;
}

function optionalString(input) {
  if (input === undefined || input === null) {
    return null;
  }
  return isString(input) && input.length > 0 ? input : null;
}

function isObjectRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isNumber(value) {
  return Object.prototype.toString.call(value) === "[object Number]";
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}

function requirePositiveNumber(input, fieldName) {
  if (!Number.isFinite(input) || input <= 0) {
    throw new RangeError(`${fieldName} must be greater than 0`);
  }
  return input;
}

function requireNonNegativeNumber(input, fieldName) {
  if (!Number.isFinite(input) || input < 0) {
    throw new RangeError(`${fieldName} must be non-negative`);
  }
  return input;
}

function requireNonNegativeInteger(input, fieldName) {
  if (!Number.isInteger(input) || input < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return input;
}

function toCents(value) {
  return Math.round(value * 100);
}

function roundPresentation(value) {
  return Number(value.toFixed(2));
}

function roundCost(value) {
  return Number(value.toFixed(12));
}

function roundQuantity(value) {
  return Number(value.toFixed(9));
}
