import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


const VALID_RECORD_TYPES = new Set(["A", "AAAA", "CNAME", "TXT", "CAA"]);
const COST_ROUTABLE_REPLICA_CLASSES = new Set(["active-active-eventual", "pinned"]);

export function routingPolicy(kind, entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("routing policy requires at least one target");
  }

  switch (kind) {
    case "weighted":
      return validateWeighted(entries);
    case "failover":
      return validateFailover(entries);
    case "latency":
      return validateRequiredField(kind, entries, "region");
    case "geo":
      return validateRequiredField(kind, entries, "geo");
    case "cost":
      return validateCost(entries);
    default:
      throw new Error(`unknown routing policy kind: ${kind}`);
  }
}

export function createPreValidationDnsPort({ domain, camp, adapter }) {
  if (!domain || !camp || !adapter) {
    throw new Error("domain, camp, and adapter are required");
  }

  return Object.freeze({
    async upsertRecord(record) {
      const normalized = normalizeRecord(domain, record);
      const beforeLive = snapshotLive(adapter, domain);
      await adapter.upsertShadowRecord(domain, normalized);
      assertLiveZoneUnchanged(adapter, domain, beforeLive);

      return dnsChange("domain.RoutingChanged", domain, camp, "upsert", normalized);
    },

    async readRecords(name) {
      const records = await adapter.readShadowRecords(domain, normalizeRecordName(domain, name));
      return records.map(cloneRecord);
    },

    async deleteRecord(name, recordType) {
      const normalizedName = normalizeRecordName(domain, name);
      const type = normalizeRecordType(recordType);
      const beforeLive = snapshotLive(adapter, domain);
      await adapter.deleteShadowRecord(domain, normalizedName, type);
      assertLiveZoneUnchanged(adapter, domain, beforeLive);

      return dnsChange("domain.RecordDeleted", domain, camp, "delete", {
        name: normalizedName,
        type,
      });
    },
  });
}

export function createInMemoryDnsAdapter({ id, shadowWritesAlsoTouchLive = false } = {}) {
  if (!id) {
    throw new Error("adapter id is required");
  }

  const shadowZones = new Map();
  const liveZones = new Map();

  function zone(map, domain) {
    if (!map.has(domain)) {
      map.set(domain, new Map());
    }
    return map.get(domain);
  }

  function upsert(map, domain, record) {
    const records = zone(map, domain);
    records.set(recordKey(record.name, record.type), cloneRecord(record));
  }

  return {
    id,

    async upsertShadowRecord(domain, record) {
      upsert(shadowZones, domain, record);
      if (shadowWritesAlsoTouchLive) {
        upsert(liveZones, domain, record);
      }
    },

    async readShadowRecords(domain, name) {
      return allRecords(zone(shadowZones, domain)).filter((record) => record.name === name);
    },

    async deleteShadowRecord(domain, name, type) {
      zone(shadowZones, domain).delete(recordKey(name, type));
      if (shadowWritesAlsoTouchLive) {
        zone(liveZones, domain).delete(recordKey(name, type));
      }
    },

    inspectShadowZone(domain) {
      return allRecords(zone(shadowZones, domain));
    },

    inspectLiveZone(domain) {
      return allRecords(zone(liveZones, domain));
    },
  };
}

export async function runDnsConformance(adapter, { domain, camp }) {
  const dns = createPreValidationDnsPort({ domain, camp, adapter });
  const failures = [];

  try {
    await dns.upsertRecord({
      name: `api.${domain}`,
      type: "A",
      ttl: 60,
      targets: [{ camp, value: "203.0.113.10" }],
      policy: routingPolicy("failover", [{ camp, priority: 1 }]),
    });
  } catch (error) {
    failures.push(error.message);
  }

  try {
    routingPolicy("weighted", [
      { camp, weight: 80 },
      { camp: "other", weight: 10 },
    ]);
    failures.push("malformed weighted routing policy was coerced");
  } catch {
    // Expected.
  }

  return {
    ok: failures.length === 0,
    adapterId: adapter.id,
    failures,
  };
}

function validateWeighted(entries) {
  let total = 0;
  const targets = entries.map((entry) => {
    const camp = requireString(entry.camp, "camp");
    const weight = Number(entry.weight);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error("weighted routing entries require positive weights");
    }
    total += weight;
    return { camp, weight };
  });

  if (total !== 100) {
    throw new Error("weighted routing weights must sum to 100");
  }

  return Object.freeze({ kind: "weighted", targets });
}

function validateFailover(entries) {
  const priorities = new Set();
  const targets = entries.map((entry) => {
    const camp = requireString(entry.camp, "camp");
    const priority = Number(entry.priority);
    if (!Number.isInteger(priority) || priority < 1) {
      throw new Error("failover routing entries require positive integer priority");
    }
    if (priorities.has(priority)) {
      throw new Error("failover routing entries require unique priority values");
    }
    priorities.add(priority);
    return { camp, priority };
  });

  return Object.freeze({ kind: "failover", targets });
}

function validateRequiredField(kind, entries, field) {
  const targets = entries.map((entry) => ({
    camp: requireString(entry.camp, "camp"),
    [field]: requireString(entry[field], field),
  }));

  return Object.freeze({ kind, targets });
}

function validateCost(entries) {
  const targets = entries.map((entry) => {
    const camp = requireString(entry.camp, "camp");
    const replicaClass = requireString(entry.replicaClass, "replicaClass");
    if (!COST_ROUTABLE_REPLICA_CLASSES.has(replicaClass)) {
      throw new Error("cost routing requires active-active-eventual or pinned replica classes");
    }
    return { camp, replicaClass };
  });

  return Object.freeze({ kind: "cost", targets });
}

function normalizeRecord(domain, record) {
  const name = normalizeRecordName(domain, record.name);
  const type = normalizeRecordType(record.type);
  const ttl = Number(record.ttl);
  if (!Number.isInteger(ttl) || ttl < 30) {
    throw new Error("DNS record ttl must be an integer >= 30 seconds");
  }
  const targets = normalizeTargets(record.targets, "target");

  return {
    name,
    type,
    ttl,
    targets,
    policy: record.policy ?? routingPolicy("failover", targets.map((target, index) => ({
      camp: target.camp,
      priority: index + 1,
    }))),
    ...(record.campOverrides ? { campOverrides: normalizeCampOverrides(record.campOverrides) } : undefined),
  };
}

function normalizeCampOverrides(overrides) {
  if (!Array.isArray(overrides)) {
    throw new Error("campOverrides must be an array");
  }
  return overrides.map((override) => ({
    camp: requireString(override.camp, "camp override camp"),
    targets: normalizeTargets(override.targets, "camp override target"),
  }));
}

function normalizeTargets(targets, field) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error(`${field} list requires at least one target`);
  }
  return targets.map((target) => ({
    camp: requireString(target.camp, `${field}.camp`),
    value: requireString(target.value, `${field}.value`),
  }));
}

function normalizeRecordName(domain, name) {
  const value = requireString(name, "record name").toLowerCase();
  if (value !== domain && !value.endsWith(`.${domain}`)) {
    throw new Error(`record ${value} must be inside domain ${domain}`);
  }
  return value;
}

function normalizeRecordType(type) {
  const value = requireString(type, "record type").toUpperCase();
  if (!VALID_RECORD_TYPES.has(value)) {
    throw new Error(`unsupported DNS record type: ${type}`);
  }
  return value;
}

function dnsChange(eventType, domain, camp, op, record) {
  const event = {
    type: eventType,
    domain,
    camp,
    op,
    record: cloneRecord(record),
  };
  return {
    zone: "shadow",
    event,
    changeId: createHash("sha256").update(canonicalJson(event)).digest("hex"),
  };
}

function assertLiveZoneUnchanged(adapter, domain, beforeLive) {
  const afterLive = snapshotLive(adapter, domain);
  if (afterLive !== beforeLive) {
    throw new Error("live zone changed during shadow write");
  }
}

function snapshotLive(adapter, domain) {
  if (!(adapter.inspectLiveZone instanceof Function)) {
    throw new Error("DNS adapter must expose inspectLiveZone for conformance");
  }
  return canonicalJson(adapter.inspectLiveZone(domain));
}

function allRecords(records) {
  return [...records.values()]
    .map(cloneRecord)
    .sort((a, b) => recordKey(a.name, a.type).localeCompare(recordKey(b.name, b.type)));
}

function recordKey(name, type) {
  return `${name}|${type}`;
}

function cloneRecord(record) {
  return JSON.parse(JSON.stringify(record));
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
