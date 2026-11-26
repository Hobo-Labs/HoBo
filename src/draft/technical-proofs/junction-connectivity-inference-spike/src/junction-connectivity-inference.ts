/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: these checks parse erased JSON-like inference, input, and recursive canonicalization values at the proof boundary. */

import { createHash } from "node:crypto";

import { ConnectivityTier } from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import { validateYardManifest } from "../../yard-topology-manifest-contract/src/yard-topology-manifest.js";
import { isJsonString, isJsonObject } from "./json.js";


export const JUNCTION_INFERENCE_SCHEMA_VERSION = "hobo.junction-connectivity-inference/v0-spike";

const CROSS_YARD_TIER_PRECEDENCE = [
  ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
  ConnectivityTier.OVERLAY_MESH,
  ConnectivityTier.PUBLIC_MTLS
];

const VALID_CROSS_YARD_TIERS = new Set(CROSS_YARD_TIER_PRECEDENCE);

export function inferJunctionConnectivity(input) {
  const baseValidation = validateInput(input);
  if (!baseValidation.ok) return baseValidation;

  const members = sortBy(input.members, (member) => member.manifest.yard.id);
  const endpointsByKey = indexEndpoints(members);
  const linkIntents = collectLinkIntents(members);
  const edges = [];

  for (const intent of linkIntents) {
    const sourceEndpoint = endpointsByKey.get(endpointKey(intent.source.yardId, intent.source.resourceId));
    const targetEndpoint = endpointsByKey.get(endpointKey(intent.target.yardId, intent.target.resourceId));

    if (!sourceEndpoint || !targetEndpoint) {
      return invalid(
        "junction.manifest.asymmetric",
        `link ${intent.id} references endpoint missing from one member Yard`
      );
    }

    if (sourceEndpoint.residencyTag !== intent.source.residencyTag || targetEndpoint.residencyTag !== intent.target.residencyTag) {
      return invalid(
        "junction.residency.mismatch",
        `link ${intent.id} manifest residency tags must match exposed endpoint residency`
      );
    }

    if (intent.source.residencyTag !== intent.target.residencyTag) {
      return invalid(
        "junction.residency.illegal",
        `link ${intent.id} crosses incompatible residency tags ${intent.source.residencyTag} -> ${intent.target.residencyTag}`
      );
    }

    const selectedTier = selectTier(intent, input.tierCapabilities ?? []);
    if (!selectedTier.ok) return selectedTier;

    edges.push(buildEdge(intent, sourceEndpoint, targetEndpoint, selectedTier.tier));
  }

  const inference = deepFreeze({
    schemaVersion: JUNCTION_INFERENCE_SCHEMA_VERSION,
    junctionId: input.junctionId,
    event: {
      type: "junction.ConnectivityInferred",
      junctionId: input.junctionId,
      edgeCount: edges.length
    },
    edges,
    halvesByYard: groupHalvesByYard(edges),
    contentHash: stableDigest({
      schemaVersion: JUNCTION_INFERENCE_SCHEMA_VERSION,
      junctionId: input.junctionId,
      edges
    })
  });

  return { ok: true, inference };
}

export function assertInferenceProperties(inference) {
  const validation = validateInference(inference);
  if (!validation.ok) {
    throw new Error(`${validation.code}: ${validation.reason}`);
  }
  return validation.properties;
}

export function validateInference(inference) {
  if (!inference || !isJsonObject(inference) || Array.isArray(inference)) {
    return invalid("junction.inference.invalid", "inference must be an object");
  }
  if (inference.schemaVersion !== JUNCTION_INFERENCE_SCHEMA_VERSION) {
    return invalid("junction.schema.unsupported", `schemaVersion must be ${JUNCTION_INFERENCE_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(inference.junctionId)) {
    return invalid("junction.required-field", "junctionId must be a non-empty string");
  }
  if (!Array.isArray(inference.edges)) {
    return invalid("junction.required-field", "edges must be an array");
  }

  const edgeIds = new Set();
  const expectedHalvesByYard = new Map();

  for (const edge of inference.edges) {
    const edgeValidation = validateEdge(edge);
    if (!edgeValidation.ok) return edgeValidation;

    if (edgeIds.has(edge.id)) {
      return invalid("junction.edge.duplicate", `edge ${edge.id} appears more than once`);
    }
    edgeIds.add(edge.id);

    if (edge.source.residencyTag !== edge.target.residencyTag) {
      return invalid("junction.residency.illegal", `edge ${edge.id} crosses incompatible residency tags`);
    }

    for (const half of edge.halves) {
      addHalf(expectedHalvesByYard, half.yardId, half);
    }
  }

  const actualHalvesByYard = new Map(Object.entries(inference.halvesByYard ?? {}));
  if (!sameHalfProjection(expectedHalvesByYard, actualHalvesByYard)) {
    return invalid("junction.halves.incomplete", "halvesByYard must contain exactly the two mirrored halves for each inferred edge");
  }

  return {
    ok: true,
    properties: {
      complete: true,
      sound: true,
      residencyLegal: true,
      deterministic: true
    }
  };
}

function validateInput(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    return invalid("junction.input.invalid", "input must be an object");
  }
  if (!isNonEmptyString(input.junctionId)) {
    return invalid("junction.required-field", "junctionId must be a non-empty string");
  }
  if (!Array.isArray(input.members) || input.members.length < 2) {
    return invalid("junction.members.required", "members must contain at least two Yard manifests");
  }

  const yardIds = new Set();
  for (const member of input.members) {
    const manifestValidation = validateYardManifest(member?.manifest);
    if (!manifestValidation.ok) return manifestValidation;
    const yardId = member.manifest.yard.id;
    if (yardIds.has(yardId)) {
      return invalid("junction.member.duplicate", `member Yard ${yardId} appears more than once`);
    }
    yardIds.add(yardId);
  }

  for (const capability of input.tierCapabilities ?? []) {
    if (!isNonEmptyString(capability?.sourceYardId) || !isNonEmptyString(capability?.targetYardId)) {
      return invalid("junction.tier-capability.required-field", "tierCapabilities require sourceYardId and targetYardId");
    }
    if (!Array.isArray(capability.supportedTiers) || capability.supportedTiers.some((tier) => !VALID_CROSS_YARD_TIERS.has(tier))) {
      return invalid("junction.tier-capability.unsupported", "supportedTiers must contain only cross-Yard tiers 3, 4, or 5");
    }
  }

  return { ok: true };
}

function collectLinkIntents(members) {
  const links = [];
  const seen = new Set();
  for (const member of members) {
    for (const link of member.manifest.crossYardLinks) {
      const key = linkKey(link);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      links.push({
        id: link.id,
        bindleId: link.bindleId,
        source: { ...link.source },
        target: { ...link.target },
        requiredTier: link.requiredTier,
        dnsRules: sortDnsRules(link.dnsRules)
      });
    }
  }
  return sortBy(links, (link) => `${link.source.yardId}:${link.id}:${link.target.yardId}`);
}

function indexEndpoints(members) {
  const endpoints = new Map();
  for (const member of members) {
    for (const endpoint of member.manifest.exposedEndpoints) {
      endpoints.set(endpointKey(member.manifest.yard.id, endpoint.resourceId), {
        ...endpoint,
        yardId: member.manifest.yard.id
      });
    }
  }
  return endpoints;
}

function selectTier(intent, capabilities) {
  if (!VALID_CROSS_YARD_TIERS.has(intent.requiredTier)) {
    return invalid("junction.tier.unsupported", `link ${intent.id} must require cross-Yard tier 3, 4, or 5`);
  }

  const pairCapabilities = capabilities
    .filter((capability) => connects(intent, capability))
    .flatMap((capability) => capability.supportedTiers);
  const supported = new Set(pairCapabilities);

  const selected = CROSS_YARD_TIER_PRECEDENCE.find((tier) => tier <= intent.requiredTier && supported.has(tier));
  if (!selected) {
    return invalid(
      "junction.tier.unresolvable",
      `link ${intent.id} has no supported tier at or better than required tier ${intent.requiredTier}`
    );
  }

  return { ok: true, tier: selected };
}

function buildEdge(intent, sourceEndpoint, targetEndpoint, tier) {
  const edgeId = `${intent.source.yardId}:${intent.source.resourceId}->${intent.target.yardId}:${intent.target.resourceId}`;
  const sourceIdentity = `spiffe://${intent.source.yardId}/${intent.bindleId}/${intent.source.resourceId}`;
  const targetIdentity = `spiffe://${intent.target.yardId}/${intent.bindleId}/${intent.target.resourceId}`;
  const dnsRules = sortDnsRules(intent.dnsRules);

  const sourceHalf = {
    kind: "junction-connectivity-half",
    edgeId,
    yardId: intent.source.yardId,
    peerYardId: intent.target.yardId,
    role: "source",
    tier,
    localResourceId: intent.source.resourceId,
    peerResourceId: intent.target.resourceId,
    localIdentity: sourceIdentity,
    peerIdentity: targetIdentity,
    dnsRules
  };

  const targetHalf = {
    kind: "junction-connectivity-half",
    edgeId,
    yardId: intent.target.yardId,
    peerYardId: intent.source.yardId,
    role: "target",
    tier,
    localResourceId: intent.target.resourceId,
    peerResourceId: intent.source.resourceId,
    localIdentity: targetIdentity,
    peerIdentity: sourceIdentity,
    dnsRules: []
  };

  return {
    id: edgeId,
    bindleId: intent.bindleId,
    tier,
    source: {
      yardId: intent.source.yardId,
      resourceId: intent.source.resourceId,
      endpoint: intent.source.endpoint,
      dnsName: sourceEndpoint.dnsName,
      residencyTag: intent.source.residencyTag,
      identity: sourceIdentity
    },
    target: {
      yardId: intent.target.yardId,
      resourceId: intent.target.resourceId,
      endpoint: intent.target.endpoint,
      dnsName: targetEndpoint.dnsName,
      residencyTag: intent.target.residencyTag,
      identity: targetIdentity
    },
    dnsRules,
    halves: [sourceHalf, targetHalf]
  };
}

function validateEdge(edge) {
  for (const [field, value] of [
    ["edge.id", edge?.id],
    ["edge.bindleId", edge?.bindleId],
    ["edge.source.yardId", edge?.source?.yardId],
    ["edge.source.resourceId", edge?.source?.resourceId],
    ["edge.source.endpoint", edge?.source?.endpoint],
    ["edge.source.dnsName", edge?.source?.dnsName],
    ["edge.source.residencyTag", edge?.source?.residencyTag],
    ["edge.source.identity", edge?.source?.identity],
    ["edge.target.yardId", edge?.target?.yardId],
    ["edge.target.resourceId", edge?.target?.resourceId],
    ["edge.target.endpoint", edge?.target?.endpoint],
    ["edge.target.dnsName", edge?.target?.dnsName],
    ["edge.target.residencyTag", edge?.target?.residencyTag],
    ["edge.target.identity", edge?.target?.identity]
  ]) {
    if (!isNonEmptyString(value)) {
      return invalid("junction.required-field", `${field} must be a non-empty string`);
    }
  }

  if (!VALID_CROSS_YARD_TIERS.has(edge.tier)) {
    return invalid("junction.tier.unsupported", "edge.tier must be cross-Yard tier 3, 4, or 5");
  }
  if (!Array.isArray(edge.halves) || edge.halves.length !== 2) {
    return invalid("junction.edge.halves", `edge ${edge.id} must emit exactly two halves`);
  }

  const sourceHalf = edge.halves.find((half) => half.role === "source");
  const targetHalf = edge.halves.find((half) => half.role === "target");
  if (!sourceHalf || !targetHalf) {
    return invalid("junction.edge.halves", `edge ${edge.id} must include one source half and one target half`);
  }

  const sourceMirror = halfMatchesEndpoint(sourceHalf, edge, "source", "target", edge.dnsRules);
  if (!sourceMirror.ok) return sourceMirror;

  const targetMirror = halfMatchesEndpoint(targetHalf, edge, "target", "source", []);
  if (!targetMirror.ok) return targetMirror;

  return { ok: true };
}

function halfMatchesEndpoint(half, edge, localRole, peerRole, dnsRules) {
  const local = edge[localRole];
  const peer = edge[peerRole];
  for (const [field, value] of [
    ["half.kind", half?.kind],
    ["half.edgeId", half?.edgeId],
    ["half.yardId", half?.yardId],
    ["half.peerYardId", half?.peerYardId],
    ["half.role", half?.role],
    ["half.localResourceId", half?.localResourceId],
    ["half.peerResourceId", half?.peerResourceId],
    ["half.localIdentity", half?.localIdentity],
    ["half.peerIdentity", half?.peerIdentity]
  ]) {
    if (!isNonEmptyString(value)) {
      return invalid("junction.required-field", `${field} must be a non-empty string`);
    }
  }

  const expected = {
    kind: "junction-connectivity-half",
    edgeId: edge.id,
    yardId: local.yardId,
    peerYardId: peer.yardId,
    role: localRole,
    tier: edge.tier,
    localResourceId: local.resourceId,
    peerResourceId: peer.resourceId,
    localIdentity: local.identity,
    peerIdentity: peer.identity,
    dnsRules
  };
  if (canonicalJson(half) !== canonicalJson(expected)) {
    return invalid("junction.edge.halves", `edge ${edge.id} ${localRole} half must mirror the inferred endpoint`);
  }

  return { ok: true };
}

function groupHalvesByYard(edges) {
  const grouped = new Map();
  for (const edge of edges) {
    for (const half of edge.halves) {
      addHalf(grouped, half.yardId, half);
    }
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([yardId, halves]) => [yardId, sortBy(halves, (half) => `${half.edgeId}:${half.role}`)])
  );
}

function sameHalfProjection(expected, actual) {
  const expectedJson = canonicalJson(Object.fromEntries([...expected.entries()].sort(([left], [right]) => left.localeCompare(right))));
  const actualJson = canonicalJson(Object.fromEntries([...actual.entries()].sort(([left], [right]) => left.localeCompare(right))));
  return expectedJson === actualJson;
}

function addHalf(grouped, yardId, half) {
  if (!grouped.has(yardId)) grouped.set(yardId, []);
  grouped.get(yardId).push(half);
}

function connects(intent, capability) {
  return capability.sourceYardId === intent.source.yardId && capability.targetYardId === intent.target.yardId;
}

function linkKey(link) {
  return `${link.id}:${link.source.yardId}:${link.source.resourceId}:${link.target.yardId}:${link.target.resourceId}`;
}

function endpointKey(yardId, resourceId) {
  return `${yardId}:${resourceId}`;
}

function sortDnsRules(rules) {
  return [...(rules ?? [])]
    .map((rule) => ({
      recordName: rule.recordName,
      type: rule.type,
      targets: [...rule.targets].sort()
    }))
    .sort((left, right) => `${left.recordName}:${left.type}`.localeCompare(`${right.recordName}:${right.type}`));
}

function sortBy(values, selector) {
  return [...values].sort((left, right) => String(selector(left)).localeCompare(String(selector(right))));
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function stableDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: these checks parse erased JSON-like inference, input, and recursive canonicalization values at the proof boundary. */
