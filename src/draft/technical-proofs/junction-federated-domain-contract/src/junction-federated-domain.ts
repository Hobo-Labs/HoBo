import { createHash } from "node:crypto";

import {
  createDomainValidationGate,
  createLiveZoneSnapshot,
  domainValidationChecks
} from "../../domain-validation-gate-contract/src/domain-validation-gate.js";
import { createPreValidationDnsPort, routingPolicy } from "../../hobo-dns-port-contract/src/dns-port.js";
import { routeCrossCampTraffic } from "../../cross-camp-routing-policy-contract/src/cross-camp-routing-policy.js";
import { isJsonString, isJsonObject } from "./json.js";


export const JUNCTION_DOMAIN_SCHEMA_VERSION = "hobo.junction-federated-domain/v1";

export async function federateJunctionDomain(input = {}) {
  const request = normalizeRequest(input);
  const residencyFailure = forbiddenResidency(request);
  if (residencyFailure) return residencyFailure;

  const deliveriesByYard = {};
  const validationByYard = {};
  for (const yard of request.yards) {
    const delivery = deliveryForYard(request, yard);
    deliveriesByYard[yard.yardId] = [delivery];

    const dns = createPreValidationDnsPort({
      domain: request.domain,
      camp: yard.camp,
      adapter: yard.dnsAdapter
    });
    const gate = createDomainValidationGate({
      checks: domainValidationChecks(yard.validationFixtures)
    });
    const validation = await gate.validate({
      domain: request.domain,
      changeId: delivery.changeId,
      camp: yard.camp,
      liveZone: createLiveZoneSnapshot(yard.dnsAdapter, request.domain),
      stage: () => dns.upsertRecord(delivery.body.dnsRecord)
    });
    validationByYard[yard.yardId] = summarizeValidation(validation);

    if (validation.status !== "validated") {
      return deepFreeze({
        status: "blocked",
        code: "junction.domain.validation-failed",
        failedYardId: yard.yardId,
        validationByYard
      });
    }
  }

  const routing = routeCrossCampTraffic({
    domain: request.domain,
    recordName: request.recordName,
    recordType: "A",
    ttl: request.ttl,
    activeCamp: request.activeCamp,
    sustainedFailureThreshold: request.sustainedFailureThreshold,
    healthSamples: request.healthSamples,
    policy: routingPolicy("failover", request.yards.map((yard, index) => ({
      camp: yard.camp,
      priority: index + 1
    }))),
    camps: request.yards.map((yard) => ({
      camp: yard.camp,
      value: yard.target,
      validated: validationByYard[yard.yardId].status === "validated",
      healthy: yard.healthy
    }))
  });

  const planWithoutHash = {
    schemaVersion: JUNCTION_DOMAIN_SCHEMA_VERSION,
    junctionId: request.junctionId,
    domain: request.domain,
    recordName: request.recordName,
    yards: request.yards.map((yard) => ({
      yardId: yard.yardId,
      camp: yard.camp,
      provider: yard.provider,
      region: yard.region,
      residency: clone(yard.residency)
    })),
    deliveriesByYard,
    validationByYard,
    routing,
    livePromotions: [],
    event: {
      type: "junction.DomainFederated",
      data: {
        junctionId: request.junctionId,
        domain: request.domain,
        yards: request.yards.map((yard) => yard.yardId),
        validation: "per-yard-shadow-gate",
        liveZoneMutationAllowed: false
      }
    }
  };

  const plan = {
    ...planWithoutHash,
    contentHash: stableDigest(planWithoutHash)
  };

  return deepFreeze({
    status: "ready",
    plan
  });
}

export function validateJunctionDomainPlan(plan) {
  if (!plan || !isJsonObject(plan) || Array.isArray(plan)) {
    return invalid("junction.domain.invalid", "plan must be an object");
  }
  if (plan.schemaVersion !== JUNCTION_DOMAIN_SCHEMA_VERSION) {
    return invalid("junction.domain.schema", `schemaVersion must be ${JUNCTION_DOMAIN_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(plan.livePromotions) || plan.livePromotions.length !== 0) {
    return invalid("junction.domain.live-promotion", "live promotions must be empty before validation clears every Yard");
  }
  if (!plan.deliveriesByYard || !isJsonObject(plan.deliveriesByYard) || Array.isArray(plan.deliveriesByYard)) {
    return invalid("junction.domain.delivery", "deliveriesByYard must be an object keyed by Yard id");
  }

  const expectedYards = new Set((plan.yards ?? []).map((yard) => yard.yardId));
  const actualYards = new Set(Object.keys(plan.deliveriesByYard));
  if (!sameSet(expectedYards, actualYards)) {
    return invalid(
      "junction.domain.delivery-incomplete",
      "delivery projection must contain exactly one domain half for every member Yard"
    );
  }

  for (const [yardId, deliveries] of Object.entries(plan.deliveriesByYard)) {
    if (!Array.isArray(deliveries)) {
      return invalid("junction.domain.delivery", `deliveriesByYard.${yardId} must be an array`);
    }
    if (deliveries.length !== 1) {
      return invalid(
        "junction.domain.delivery-incomplete",
        "delivery projection must contain exactly one domain half for every member Yard"
      );
    }
    for (const delivery of deliveries) {
      const deliveredYard = delivery?.body?.yardId ?? delivery?.yardId ?? "unknown";
      if (delivery?.yardId !== yardId || delivery?.body?.yardId !== yardId) {
        return invalid(
          "junction.domain.yard-leak",
          `delivery for ${deliveredYard} cannot be placed in ${yardId} domain log`
        );
      }
      if (delivery.streamId !== `yard:${yardId}:domains`) {
        return invalid("junction.domain.stream", `delivery for ${yardId} must land in that Yard's domain log`);
      }
      if (!recordTargetsOnlyCamp(delivery.body.dnsRecord, delivery.body.camp)) {
        return invalid(
          "junction.domain.yard-leak",
          `delivery for ${deliveredYard} cannot be placed in ${yardId} domain log`
        );
      }
      if (delivery.body.certChallenge?.yardId !== yardId) {
        return invalid(
          "junction.domain.yard-leak",
          `delivery for ${deliveredYard} cannot be placed in ${yardId} domain log`
        );
      }
    }
  }

  return { ok: true };
}

function deliveryForYard(request, yard) {
  const dnsRecord = {
    name: request.recordName,
    type: "A",
    ttl: request.ttl,
    targets: [{ camp: yard.camp, value: yard.target }],
    policy: routingPolicy("failover", [{ camp: yard.camp, priority: 1 }])
  };
  const certChallenge = {
    yardId: yard.yardId,
    camp: yard.camp,
    name: `_acme-challenge.${request.domain}`,
    source: "identity-acme-dns01"
  };
  const body = {
    junctionId: request.junctionId,
    domain: request.domain,
    yardId: yard.yardId,
    camp: yard.camp,
    provider: yard.provider,
    region: yard.region,
    residency: clone(yard.residency),
    dnsRecord,
    certChallenge,
    validationGate: "shadow-before-live"
  };

  return deepFreeze({
    type: "resource.JunctionDomainHalfPlanned",
    streamId: `yard:${yard.yardId}:domains`,
    yardId: yard.yardId,
    changeId: stableDigest(body),
    body
  });
}

function summarizeValidation(validation) {
  return deepFreeze({
    status: validation.status,
    ...(validation.failedCheck ? { failedCheck: validation.failedCheck } : undefined),
    ...(validation.reason ? { reason: validation.reason } : undefined),
    checks: validation.checks ?? [],
    events: validation.events
  });
}

function forbiddenResidency(request) {
  const forbidden = request.yards.find((yard) => !yard.residency.allowedRegions.includes(yard.region));
  if (!forbidden) return null;
  return deepFreeze({
    status: "refused",
    code: "junction.domain.residency-forbidden",
    reason: `yard ${forbidden.yardId} in ${forbidden.region} cannot front residency ${forbidden.residency.tag} domain ${request.domain}`
  });
}

function normalizeRequest(input) {
  const domain = requireString(input.domain, "domain").toLowerCase();
  const yards = normalizeYards(input.yards);
  return {
    junctionId: requireString(input.junctionId, "junctionId"),
    domain,
    recordName: requireString(input.recordName ?? domain, "recordName").toLowerCase(),
    ttl: positiveInteger(input.ttl ?? 60, "ttl"),
    activeCamp: requireString(input.activeCamp ?? yards[0].camp, "activeCamp"),
    sustainedFailureThreshold: positiveInteger(input.sustainedFailureThreshold ?? 2, "sustainedFailureThreshold"),
    healthSamples: Array.isArray(input.healthSamples) ? input.healthSamples.map(clone) : [],
    yards
  };
}

function normalizeYards(yards) {
  if (!Array.isArray(yards) || yards.length < 2) {
    throw new Error("cross-cloud domain federation requires at least two Yards");
  }
  const seen = new Set();
  return yards.map((yard) => {
    const normalized = {
      yardId: requireString(yard.yardId, "yardId"),
      provider: requireString(yard.provider, "provider"),
      region: requireString(yard.region, "region"),
      camp: requireString(yard.camp, "camp"),
      target: requireString(yard.target, "target"),
      dnsAdapter: requireDnsAdapter(yard.dnsAdapter),
      healthy: yard.healthy !== false,
      validationFixtures: yard.validationFixtures ?? {},
      residency: normalizeResidency(yard.residency)
    };
    if (seen.has(normalized.yardId)) {
      throw new Error(`duplicate Yard: ${normalized.yardId}`);
    }
    seen.add(normalized.yardId);
    return normalized;
  }).sort((left, right) => left.yardId.localeCompare(right.yardId));
}

function normalizeResidency(residency = {}) {
  const tag = requireString(residency.tag ?? "global", "residency.tag");
  const allowedRegions = residency.allowedRegions ?? [];
  if (!Array.isArray(allowedRegions) || allowedRegions.length === 0) {
    throw new Error("residency.allowedRegions requires at least one region");
  }
  return {
    tag,
    allowedRegions: allowedRegions.map((region) => requireString(region, "residency region"))
  };
}

function requireDnsAdapter(adapter) {
  if (
    !adapter ||
    !(adapter.upsertShadowRecord instanceof Function) ||
    !(adapter.inspectLiveZone instanceof Function) ||
    !(adapter.inspectShadowZone instanceof Function)
  ) {
    throw new Error("Junction domain federation requires a hobo:dns shadow adapter per Yard");
  }
  return adapter;
}

function recordTargetsOnlyCamp(record, camp) {
  return Array.isArray(record?.targets) && record.targets.every((target) => target.camp === camp);
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}

function sameSet(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function positiveInteger(value, field) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return normalized;
}

function requireString(value, field) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function stableDigest(value) {
  return createHash("sha256").update(`${JSON.stringify(sortJson(value), null, 2)}\n`).digest("hex");
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
