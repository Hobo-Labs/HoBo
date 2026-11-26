import { createHash } from "node:crypto";

import {
  createDomainValidationGate,
  createLiveZoneSnapshot,
} from "../../domain-validation-gate-contract/src/domain-validation-gate.js";
import {
  createPreValidationDnsPort,
  routingPolicy,
} from "../../hobo-dns-port-contract/src/dns-port.js";
import { planGatewayRequest } from "../../gateway-realization-contract/src/gateway-realization.js";
import { isJsonString, isJsonObject } from "./json.js";


export const YARD_DOMAIN_CONTRACT_VERSION = "hobo.yard-domain/v1";

export function domain(name) {
  const draft = {
    domain: normalizeDomain(name),
    yard: null,
    routes: [],
    routingPolicy: null,
    campOverrides: [],
  };

  return {
    ownedByYard(id, options = {}) {
      draft.yard = {
        id: requireString(id, "yard id"),
        provider: requireString(options.provider, "yard provider"),
        defaultCamp: requireString(options.defaultCamp, "yard defaultCamp"),
      };
      return this;
    },

    routes(target, options = {}) {
      const path = normalizePath(options.path ?? "/");
      const recordName = normalizeRecordName(draft.domain, options.recordName ?? draft.domain);
      const camp = requireString(options.camp ?? draft.yard?.defaultCamp, "route camp");
      const value = requireString(options.target, "route target");

      draft.routes.push({
        host: draft.domain,
        path,
        target: clone(target),
        dnsRecord: {
          name: recordName,
          type: normalizeRecordType(options.recordType ?? "A"),
          ttl: normalizeTtl(options.ttl ?? 60),
          targets: [{ camp, value }],
        },
      });
      return this;
    },

    routing(kind, entries) {
      draft.routingPolicy = routingPolicy(kind, entries);
      return this;
    },

    campOverride(camp, options = {}) {
      const overrideCamp = requireString(camp, "camp override camp");
      const value = requireString(options.target, "camp override target");
      draft.campOverrides.push({
        camp: overrideCamp,
        recordName: normalizeRecordName(draft.domain, options.recordName ?? draft.domain),
        targets: [{ camp: overrideCamp, value }],
      });
      return this;
    },

    build() {
      if (!draft.yard) {
        throw new Error("domain declaration must be owned by a Yard");
      }
      if (draft.routes.length === 0) {
        throw new Error("domain declaration requires at least one route");
      }

      const primaryRecord = primaryDnsRecord(draft);
      return deepFreeze({
        version: YARD_DOMAIN_CONTRACT_VERSION,
        kind: "yard-domain",
        scope: "yard",
        domain: draft.domain,
        yard: clone(draft.yard),
        routes: draft.routes.map((route) => clone(route)),
        routingPolicy: clone(draft.routingPolicy ?? defaultFailoverPolicy(primaryRecord.targets)),
        campOverrides: draft.campOverrides.map((override) => clone(override)),
      });
    },
  };
}

export async function validateYardDomain(declaration, options = {}) {
  const normalized = normalizeDeclaration(declaration);
  const adapter = requireAdapter(options.adapter);
  const dns = createPreValidationDnsPort({
    domain: normalized.domain,
    camp: normalized.yard.defaultCamp,
    adapter,
  });
  const dnsRecord = primaryDnsRecord(normalized);
  const checks = options.checks ?? createYardDomainValidationChecks(normalized, options);
  const gate = options.gate ?? createDomainValidationGate({ checks, timeoutMs: options.timeoutMs });
  let shadowChange;

  const result = await gate.validate({
    domain: normalized.domain,
    changeId: domainChangeId(normalized),
    camp: normalized.yard.defaultCamp,
    liveZone: createLiveZoneSnapshot(adapter, normalized.domain),
    stage: async () => {
      shadowChange = await dns.upsertRecord(dnsRecord);
      return shadowChange;
    },
  });

  return deepFreeze({
    ...result,
    declaration: normalized,
    dnsRecord,
    shadowChange,
  });
}

export function createYardDomainValidationChecks(declaration, options = {}) {
  const normalized = normalizeDeclaration(declaration);
  const record = primaryDnsRecord(normalized);
  const expectedTargets = record.targets.map((target) => target.value).sort();

  return Object.freeze({
    "multi-vantage-resolve": async () => {
      const resolvers = normalizeResolvers(options.resolvers);
      const results = await resolveFromAll(resolvers, record);
      const mismatches = results.filter((result) => !arraysEqual(result.values, expectedTargets));
      if (mismatches.length > 0) {
        return fail(
          `split-horizon resolver disagreement for ${record.name}: expected ${expectedTargets.join(", ")}`,
          { results },
        );
      }
      return pass({ recordName: record.name, vantagePoints: results.map((result) => result.id) });
    },

    "ttl-aware-propagation": async () => {
      const waitedSeconds = Number(options.propagation?.waitedSeconds);
      if (!Number.isFinite(waitedSeconds)) {
        return fail("TTL propagation check requires waitedSeconds");
      }
      if (waitedSeconds < record.ttl) {
        return fail(`TTL propagation waited ${waitedSeconds}s, below TTL ${record.ttl}s`);
      }
      const visible = await resolveFromAll(normalizeResolvers(options.resolvers), record, "after-ttl");
      const missing = visible.filter((result) => !arraysEqual(result.values, expectedTargets));
      if (missing.length > 0) {
        return fail(`record ${record.name} not visible after TTL ${record.ttl}s`, {
          waitedSeconds,
          ttlSeconds: record.ttl,
          results: visible,
        });
      }
      return pass({ waitedSeconds, ttlSeconds: record.ttl, vantagePoints: visible.map((result) => result.id) });
    },

    "acme-challenge": async () => {
      const challengeName = `_acme-challenge.${normalized.domain}`;
      const ok = await options.acme?.isChallengeReady?.(challengeName, normalized.domain);
      if (ok !== true) {
        return fail(`ACME DNS-01 challenge is not ready for ${challengeName}`);
      }
      return pass({ challengeName });
    },

    "endpoint-health": async () => {
      const requests = healthProbeRequests(normalized);
      const responses = [];
      for (const request of requests) {
        const response = await options.gateway?.probe?.(request);
        responses.push({ camp: request.camp, path: request.path, response });
        if (!response?.served) {
          return fail(
            `endpoint health check failed for ${request.camp}${request.path} with ${response?.status ?? "unknown"} ${
              response?.reason ?? ""
            }`.trim(),
            { responses },
          );
        }
      }
      return pass({ probes: responses.map((item) => ({ camp: item.camp, path: item.path, status: item.response.status })) });
    },
  });
}

export function createStaticResolver(id, records, options = {}) {
  const resolverId = requireString(id, "resolver id");
  const normalizedRecords = new Map(
    Object.entries(records ?? {}).map(([name, values]) => [
      normalizeRecordNameForLookup(name),
      Array.isArray(values) ? values.map(String) : [String(values)],
    ]),
  );
  const afterTtlRecords = new Map(
    Object.entries(options.afterTtlRecords ?? records ?? {}).map(([name, values]) => [
      normalizeRecordNameForLookup(name),
      Array.isArray(values) ? values.map(String) : [String(values)],
    ]),
  );

  return Object.freeze({
    id: resolverId,
    async resolve(name) {
      return [...(normalizedRecords.get(normalizeRecordNameForLookup(name)) ?? [])];
    },
    async resolveAfterTtl(name) {
      return [...(afterTtlRecords.get(normalizeRecordNameForLookup(name)) ?? [])];
    },
  });
}

export function createAcmeDns01Authority(challenges) {
  const ready = new Set(
    Object.entries(challenges ?? {})
      .filter(([, value]) => value === true || value === "ready")
      .map(([name]) => normalizeRecordNameForLookup(name)),
  );

  return Object.freeze({
    async isChallengeReady(challengeName) {
      return ready.has(normalizeRecordNameForLookup(challengeName));
    },
  });
}

export function createGatewayHealthProbe(deployment) {
  return Object.freeze({
    probe(request) {
      return planGatewayRequest(deployment, request);
    },
  });
}

function primaryDnsRecord(declaration) {
  const route = declaration.routes?.[0];
  if (!route?.dnsRecord) {
    throw new Error("domain declaration requires a route DNS record");
  }
  return {
    ...clone(route.dnsRecord),
    policy: clone(declaration.routingPolicy ?? defaultFailoverPolicy(route.dnsRecord.targets)),
    ...(declaration.campOverrides?.length
      ? {
          campOverrides: declaration.campOverrides.map((override) => ({
            camp: override.camp,
            targets: clone(override.targets),
          })),
        }
      : undefined),
  };
}

async function resolveFromAll(resolvers, record, mode = "current") {
  return Promise.all(
    resolvers.map(async (resolver) => ({
      id: resolver.id,
      values: (
        mode === "after-ttl" && resolver.resolveAfterTtl instanceof Function
          ? await resolver.resolveAfterTtl(record.name, record.type)
          : await resolver.resolve(record.name, record.type)
      )
        .map(String)
        .sort(),
    })),
  );
}

function healthProbeRequests(declaration) {
  const requests = [];
  for (const route of declaration.routes) {
    const camps = new Set([
      ...route.dnsRecord.targets.map((target) => target.camp),
      ...(declaration.campOverrides ?? []).flatMap((override) => override.targets.map((target) => target.camp)),
    ]);
    for (const camp of camps) {
      requests.push({
        scheme: "https",
        host: declaration.domain,
        path: route.path,
        method: "GET",
        camp,
      });
    }
  }
  return requests;
}

function normalizeDeclaration(declaration) {
  if (!declaration || !isJsonObject(declaration)) {
    throw new Error("Yard domain declaration is required");
  }
  if (declaration.kind !== "yard-domain" || declaration.scope !== "yard") {
    throw new Error("domain declaration must be a Yard-level domain");
  }
  return declaration;
}

function defaultFailoverPolicy(targets) {
  return routingPolicy(
    "failover",
    targets.map((target, index) => ({ camp: target.camp, priority: index + 1 })),
  );
}

function normalizeResolvers(resolvers) {
  if (!Array.isArray(resolvers) || resolvers.length < 2) {
    throw new Error("multi-vantage resolve requires at least two resolvers");
  }
  const ids = new Set();
  return resolvers.map((resolver) => {
    if (!resolver || !(resolver.resolve instanceof Function)) {
      throw new Error("resolver requires a resolve function");
    }
    const id = requireString(resolver.id, "resolver id");
    if (ids.has(id)) {
      throw new Error(`duplicate resolver id: ${id}`);
    }
    ids.add(id);
    return resolver;
  });
}

function requireAdapter(adapter) {
  if (!adapter || !(adapter.inspectLiveZone instanceof Function)) {
    throw new Error("DNS adapter with inspectLiveZone is required");
  }
  return adapter;
}

function normalizeDomain(name) {
  const value = requireString(name, "domain").toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) || !value.includes(".")) {
    throw new Error(`invalid domain: ${name}`);
  }
  return value;
}

function normalizeRecordName(domainName, name) {
  const value = normalizeRecordNameForLookup(name);
  if (value !== domainName && !value.endsWith(`.${domainName}`)) {
    throw new Error(`record ${value} must be inside domain ${domainName}`);
  }
  return value;
}

function normalizeRecordNameForLookup(name) {
  return requireString(name, "record name").toLowerCase();
}

function normalizeRecordType(type) {
  const value = requireString(type, "record type").toUpperCase();
  if (!["A", "AAAA", "CNAME"].includes(value)) {
    throw new Error(`unsupported Yard domain record type: ${type}`);
  }
  return value;
}

function normalizePath(path) {
  const value = requireString(path, "route path");
  if (!value.startsWith("/")) {
    throw new Error(`route path must be absolute: ${path}`);
  }
  return value;
}

function normalizeTtl(value) {
  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl < 30) {
    throw new Error("domain route ttl must be an integer >= 30 seconds");
  }
  return ttl;
}

function domainChangeId(declaration) {
  return createHash("sha256").update(canonicalJson(declaration)).digest("hex");
}

function pass(evidence) {
  return Object.freeze({ ok: true, evidence });
}

function fail(reason, evidence = {}) {
  return Object.freeze({ ok: false, reason, evidence });
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireString(value, field) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}
