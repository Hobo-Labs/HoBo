import { createHash } from "node:crypto";

import { ConnectivityTier } from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import { isJsonString, isJsonObject } from "./json.js";


export const YARD_MANIFEST_SCHEMA_VERSION = "hobo.yard-manifest/v1";

const VALID_TIERS = new Set(Object.values(ConnectivityTier));
const VALID_DNS_TYPES = new Set(["A", "AAAA", "CNAME"]);
const VALID_OVERRIDE_KINDS = new Set(["dns-record", "connectivity-tier"]);

export function projectYardManifest(topology) {
  const validation = validateDeclaredTopology(topology);
  if (!validation.ok) {
    throw new Error(`${validation.code}: ${validation.reason}`);
  }

  const manifestWithoutHash = sortKeys({
    schemaVersion: YARD_MANIFEST_SCHEMA_VERSION,
    yard: {
      id: topology.yard.id,
      provider: topology.yard.provider,
      regions: sortedStrings(topology.yard.regions),
      ...(topology.yard.junctionId ? { junctionId: topology.yard.junctionId } : undefined)
    },
    providerZones: sortedById(topology.providerZones ?? []).map((zone) => ({
      id: zone.id,
      domain: zone.domain,
      regions: sortedStrings(zone.regions ?? [])
    })),
    exposedEndpoints: sortedById(topology.exposedEndpoints ?? [], "logicalName").map((endpoint) => ({
      logicalName: endpoint.logicalName,
      resourceId: endpoint.resourceId,
      campId: endpoint.campId,
      provider: endpoint.provider,
      region: endpoint.region,
      dnsName: endpoint.dnsName,
      residencyTag: endpoint.residencyTag
    })),
    crossYardLinks: sortedById(topology.crossYardLinks ?? []).map((link) => ({
      id: link.id,
      bindleId: link.bindleId,
      source: { ...link.source },
      target: { ...link.target },
      requiredTier: link.requiredTier,
      dnsRules: sortedDnsRules(link.dnsRules ?? [])
    })),
    topologyOverrides: sortedById(topology.topologyOverrides ?? []).map(projectTopologyOverride)
  });

  return deepFreeze({
    ...manifestWithoutHash,
    contentHash: stableDigest(manifestWithoutHash)
  });
}

export function validateYardManifest(manifest) {
  if (!manifest || !isJsonObject(manifest) || Array.isArray(manifest)) {
    return invalid("yard.manifest.invalid", "manifest must be an object");
  }
  if (manifest.schemaVersion !== YARD_MANIFEST_SCHEMA_VERSION) {
    return invalid("yard.schema.unsupported", `schemaVersion must be ${YARD_MANIFEST_SCHEMA_VERSION}`);
  }
  const topologyValidation = validateDeclaredTopology(manifest);
  if (!topologyValidation.ok) return topologyValidation;
  if (!isNonEmptyString(manifest.contentHash)) {
    return invalid("yard.manifest.required-field", "contentHash must be a non-empty string");
  }
  if (manifest.contentHash !== stableDigest(manifestContentForHash(manifest))) {
    return invalid("yard.manifest.hash-mismatch", "contentHash does not match YardManifest content");
  }

  return { ok: true };
}

function validateDeclaredTopology(topology) {
  if (!topology || !isJsonObject(topology) || Array.isArray(topology)) {
    return invalid("yard.topology.invalid", "declared topology must be an object");
  }

  for (const [field, value] of [
    ["yard.id", topology.yard?.id],
    ["yard.provider", topology.yard?.provider]
  ]) {
    if (!isNonEmptyString(value)) {
      return invalid("yard.topology.required-field", `${field} must be a non-empty string`);
    }
  }

  if (!Array.isArray(topology.yard?.regions) || topology.yard.regions.length === 0) {
    return invalid("yard.topology.required-field", "yard.regions must contain at least one region");
  }

  for (const region of topology.yard.regions) {
    if (!isNonEmptyString(region)) {
      return invalid("yard.topology.required-field", "yard.regions must contain only non-empty strings");
    }
  }

  for (const field of ["providerZones", "exposedEndpoints", "crossYardLinks", "topologyOverrides"]) {
    if (topology[field] !== undefined && !Array.isArray(topology[field])) {
      return invalid("yard.topology.required-field", `${field} must be an array when present`);
    }
  }

  for (const zone of topology.providerZones ?? []) {
    for (const [field, value] of [
      ["providerZones.id", zone.id],
      ["providerZones.domain", zone.domain]
    ]) {
      if (!isNonEmptyString(value)) {
        return invalid("yard.topology.required-field", `${field} must be a non-empty string`);
      }
    }
    if (!Array.isArray(zone.regions) || zone.regions.some((region) => !isNonEmptyString(region))) {
      return invalid("yard.topology.required-field", "providerZones.regions must contain only non-empty strings");
    }
  }

  for (const endpoint of topology.exposedEndpoints ?? []) {
    for (const [field, value] of [
      ["exposedEndpoints.logicalName", endpoint.logicalName],
      ["exposedEndpoints.resourceId", endpoint.resourceId],
      ["exposedEndpoints.campId", endpoint.campId],
      ["exposedEndpoints.provider", endpoint.provider],
      ["exposedEndpoints.region", endpoint.region],
      ["exposedEndpoints.dnsName", endpoint.dnsName],
      ["exposedEndpoints.residencyTag", endpoint.residencyTag]
    ]) {
      if (!isNonEmptyString(value)) {
        return invalid("yard.topology.required-field", `${field} must be a non-empty string`);
      }
    }
    if (endpoint.provider !== topology.yard.provider || !topology.yard.regions.includes(endpoint.region)) {
      return invalid(
        "yard.endpoint.outside-region",
        `endpoint ${endpoint.logicalName} must stay inside provider ${topology.yard.provider} regions ${topology.yard.regions.join(", ")}`
      );
    }
  }

  for (const link of topology.crossYardLinks ?? []) {
    for (const [field, value] of [
      ["crossYardLinks.id", link.id],
      ["crossYardLinks.bindleId", link.bindleId],
      ["crossYardLinks.source.yardId", link.source?.yardId],
      ["crossYardLinks.source.resourceId", link.source?.resourceId],
      ["crossYardLinks.source.endpoint", link.source?.endpoint],
      ["crossYardLinks.source.residencyTag", link.source?.residencyTag],
      ["crossYardLinks.target.yardId", link.target?.yardId],
      ["crossYardLinks.target.resourceId", link.target?.resourceId],
      ["crossYardLinks.target.endpoint", link.target?.endpoint],
      ["crossYardLinks.target.residencyTag", link.target?.residencyTag]
    ]) {
      if (!isNonEmptyString(value)) {
        return invalid("yard.topology.required-field", `${field} must be a non-empty string`);
      }
    }
    if (!VALID_TIERS.has(link.requiredTier)) {
      return invalid("yard.link.unsupported-tier", "crossYardLinks.requiredTier must be one of 1, 2, 3, 4, 5");
    }
    for (const rule of link.dnsRules ?? []) {
      const ruleValidation = validateDnsRule(rule, "crossYardLinks.dnsRules");
      if (!ruleValidation.ok) return ruleValidation;
    }
  }

  const linkIds = new Set((topology.crossYardLinks ?? []).map((link) => link.id));
  for (const override of topology.topologyOverrides ?? []) {
    for (const [field, value] of [
      ["topologyOverrides.id", override.id],
      ["topologyOverrides.kind", override.kind],
      ["topologyOverrides.reason", override.reason]
    ]) {
      if (!isNonEmptyString(value)) {
        return invalid("yard.topology.required-field", `${field} must be a non-empty string`);
      }
    }
    if (!VALID_OVERRIDE_KINDS.has(override.kind)) {
      return invalid("yard.override.unsupported-kind", "topologyOverrides.kind must be dns-record or connectivity-tier");
    }
    if (override.kind === "dns-record") {
      const overrideValidation = validateDnsRule(override, "topologyOverrides");
      if (!overrideValidation.ok) return overrideValidation;
    } else {
      if (!isNonEmptyString(override.linkId)) {
        return invalid("yard.topology.required-field", "topologyOverrides.linkId must be a non-empty string");
      }
      if (!VALID_TIERS.has(override.requiredTier)) {
        return invalid("yard.link.unsupported-tier", "topologyOverrides.requiredTier must be one of 1, 2, 3, 4, 5");
      }
      if (!linkIds.has(override.linkId)) {
        return invalid("yard.override.unknown-link", `tier override ${override.id} references unknown link ${override.linkId}`);
      }
    }
  }

  const overrideConflict = findOverrideConflict(topology);
  if (overrideConflict) {
    return invalid(
      "yard.override.conflict",
      `override ${overrideConflict.overrideId} conflicts with inferred DNS ${overrideConflict.recordKey}`
    );
  }

  return { ok: true };
}

function projectTopologyOverride(override) {
  if (override.kind === "connectivity-tier") {
    return {
      id: override.id,
      kind: override.kind,
      linkId: override.linkId,
      requiredTier: override.requiredTier,
      reason: override.reason
    };
  }
  return {
    id: override.id,
    kind: override.kind,
    recordName: override.recordName,
    type: override.type,
    targets: sortedStrings(override.targets),
    reason: override.reason
  };
}

function validateDnsRule(rule, field) {
  if (!isNonEmptyString(rule?.recordName)) {
    return invalid("yard.topology.required-field", `${field}.recordName must be a non-empty string`);
  }
  if (!VALID_DNS_TYPES.has(rule.type)) {
    return invalid("yard.dns.unsupported-type", `${field}.type must be A, AAAA, or CNAME`);
  }
  if (!Array.isArray(rule.targets) || rule.targets.length === 0 || rule.targets.some((target) => !isNonEmptyString(target))) {
    return invalid("yard.topology.required-field", `${field}.targets must contain non-empty strings`);
  }
  return { ok: true };
}

function findOverrideConflict(topology) {
  const inferred = new Map();
  for (const link of topology.crossYardLinks ?? []) {
    for (const rule of link.dnsRules ?? []) {
      inferred.set(dnsRuleKey(rule), sortedStrings(rule.targets).join("\0"));
    }
  }

  for (const override of sortedById(topology.topologyOverrides ?? [])) {
    if (override.kind !== "dns-record") continue;
    const recordKey = dnsRuleKey(override);
    const inferredTargets = inferred.get(recordKey);
    if (inferredTargets !== undefined && inferredTargets !== sortedStrings(override.targets).join("\0")) {
      return { overrideId: override.id, recordKey };
    }
  }

  return null;
}

function dnsRuleKey(rule) {
  return `${rule.recordName}:${rule.type}`;
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function sortedStrings(values) {
  return [...values].map(String).sort();
}

function sortedById(values, key = "id") {
  return [...values].sort((left, right) => String(left[key]).localeCompare(String(right[key])));
}

function sortedDnsRules(rules) {
  return [...rules]
    .map((rule) => ({
      recordName: rule.recordName,
      type: rule.type,
      targets: sortedStrings(rule.targets)
    }))
    .sort((left, right) => `${left.recordName}:${left.type}`.localeCompare(`${right.recordName}:${right.type}`));
}

function stableDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function manifestContentForHash(manifest) {
  const { contentHash: _contentHash, ...content } = manifest;
  return content;
}

function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || !isJsonObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}
