import {
  ConnectivityTier,
  validateConnectivityPlan
} from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import {
  evaluateMtlsHandshake,
  parseWorkloadSpiffeId
} from "../../mtls-data-path-contract/src/mtls-data-path.js";
import { isJsonString, isJsonObject } from "./json.js";


export const TIER_FOUR_OVERLAY_MESH_SCHEMA_VERSION = "hobo.tier-four-overlay-mesh/v1";

const DEFAULT_PROVIDER_OUTPUT_KEY = "overlayEndpoint";
const WIREGUARD_EBPF_MESH_KIND = "wireguard-ebpf";
const VALID_LIFECYCLE_STATES = new Set(["missing", "active", "draining", "partitioned", "retired"]);

export function realizeTierFourOverlayMesh(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    return invalid("tier4.input.invalid", "input must be an object");
  }

  const planValidation = validateTierFourPlan(input.plan);
  if (!planValidation.ok) return planValidation;

  const residency = validateResidencyBoundary(input.plan);
  if (!residency.ok) return residency;

  const overlayNodes = resolveOverlayNodes(input.overlayNodeCatalog, input.plan);
  if (!overlayNodes.ok) return overlayNodes;

  const binding = resolveBindingFromOutputs(input.plan, input.providerOutputs);
  if (!binding.ok) return binding;

  const verbs = normalizeVerbs(input.verbs);
  if (!verbs.ok) return verbs;

  let sourceIdentity;
  let targetIdentity;
  try {
    sourceIdentity = parseWorkloadSpiffeId(input.plan.identity.source);
    targetIdentity = parseWorkloadSpiffeId(input.plan.identity.target);
  } catch (error) {
    return invalid("tier4.identity.invalid", error.message);
  }
  if (sourceIdentity.resource !== input.plan.source.resourceId) {
    return invalid(
      "tier4.identity.source-mismatch",
      `source SVID resource ${sourceIdentity.resource} does not match plan source ${input.plan.source.resourceId}`
    );
  }
  if (targetIdentity.resource !== input.plan.target.resourceId) {
    return invalid(
      "tier4.identity.target-mismatch",
      `target SVID resource ${targetIdentity.resource} does not match plan target ${input.plan.target.resourceId}`
    );
  }

  const allowedPeer = {
    fromResourceId: input.plan.source.resourceId,
    toResourceId: input.plan.target.resourceId,
    peerSvid: input.plan.identity.target,
    verbs: verbs.value
  };

  const link = {
    schemaVersion: TIER_FOUR_OVERLAY_MESH_SCHEMA_VERSION,
    edgeId: input.plan.edgeId,
    tier: ConnectivityTier.OVERLAY_MESH,
    sourceProvider: input.plan.source.provider,
    targetProvider: input.plan.target.provider,
    source: { ...input.plan.source },
    target: { ...input.plan.target },
    sourceSvid: input.plan.identity.source,
    targetSvid: input.plan.identity.target,
    overlayNodes: overlayNodes.nodes,
    bindingInjection: binding.binding,
    residency: input.plan.residency ? clone(input.plan.residency) : undefined,
    route: {
      transport: "wireguard-ebpf-overlay",
      publicExposure: false,
      meshKind: input.plan.parameters.meshKind,
      meshPolicyRef: input.plan.parameters.meshPolicyRef,
      fallbackFromTier: input.plan.parameters.fallbackFromTier,
      fallbackReason: input.plan.parameters.fallbackReason
    },
    meshPolicy: {
      id: input.plan.parameters.meshPolicyRef,
      flatNetwork: false,
      allowedPeers: [allowedPeer]
    }
  };

  const mtlsContract = {
    schemaVersion: "hobo.mtls-data-path/v1",
    connectionId: `${input.plan.edgeId}:tier4-mtls`,
    tenant: sourceIdentity.tenant,
    trustDomain: sourceIdentity.trustDomain,
    sourceSvid: input.plan.identity.source,
    certMaterialRef: `identity://${sourceIdentity.tenant}/${sourceIdentity.bindle}/${sourceIdentity.resource}/tier4/${input.plan.edgeId}`,
    peerCertificate: input.peerCertificate,
    allowedPeers: [input.plan.identity.target],
    authz: {
      bindEdgeId: input.plan.edgeId,
      verbs: verbs.value
    },
    now: input.now,
    minimumPeerRotationEpoch: input.minimumPeerRotationEpoch
  };

  const mtls = evaluateMtlsHandshake(mtlsContract);
  if (!mtls.ok) {
    return {
      ok: false,
      code: mtls.code,
      reason: mtls.reason,
      link
    };
  }

  return {
    ok: true,
    link,
    mtls,
    contract: mtlsContract
  };
}

export function resolveTierFourBinding(link, providerOutputs) {
  if (!link || !isJsonObject(link) || Array.isArray(link)) {
    return invalid("tier4.link.invalid", "link must be an object");
  }

  const result = resolveBindingForResource({
    targetResourceId: link.target?.resourceId,
    sourceResourceId: link.source?.resourceId,
    binding: link.bindingInjection?.binding,
    sourceProvider: link.sourceProvider,
    targetProvider: link.targetProvider,
    providerOutputs
  });
  if (!result.ok) return result;
  return { ok: true, ...result.binding };
}

export function canReachTierFourPeer(link, attempt) {
  if (!link || !isJsonObject(link) || Array.isArray(link)) {
    return invalid("tier4.link.invalid", "link must be an object");
  }
  if (!attempt || !isJsonObject(attempt) || Array.isArray(attempt)) {
    return invalid("tier4.reachability.invalid", "attempt must be an object");
  }

  if (attempt.fromResourceId !== link.source?.resourceId || attempt.toResourceId !== link.target?.resourceId) {
    return invalid(
      "tier4.peer.not-bound",
      `${attempt.fromResourceId} is not the bind edge source for ${attempt.toResourceId}`
    );
  }

  if (attempt.peerSvid !== link.targetSvid) {
    return invalid(
      "tier4.peer.svid-not-bound",
      `${attempt.peerSvid} is not the bind-derived target SVID for ${link.target?.resourceId}`
    );
  }

  if (link.route?.publicExposure !== false) {
    return invalid("tier4.route.public-exposed", "tier 4 overlay reachability must stay private");
  }

  return { ok: true };
}

export function evaluateOverlayNodeState(link, observedState) {
  if (!link || !isJsonObject(link) || Array.isArray(link)) {
    return invalid("tier4.link.invalid", "link must be an object");
  }
  if (!observedState || !isJsonObject(observedState) || Array.isArray(observedState)) {
    return invalid("tier4.observed-state.invalid", "observedState must be an object");
  }
  if (observedState.publicFallbackActive === true) {
    return {
      ok: false,
      code: "tier4.overlay.public-fallback-forbidden",
      reason: "tier 4 overlay partition cannot silently route over public networking",
      failClosed: true
    };
  }
  if (!Array.isArray(observedState.nodes)) {
    return invalid("tier4.observed-state.invalid", "observedState.nodes must be an array");
  }

  const observedById = new Map(observedState.nodes.map((node) => [node?.nodeId, node]));
  const segments = new Set();

  for (const expectedNode of link.overlayNodes ?? []) {
    const observedNode = observedById.get(expectedNode.nodeId);
    if (!observedNode) {
      return {
        ok: false,
        code: "tier4.overlay.node-missing",
        reason: `overlay node ${expectedNode.nodeId} is not observed`,
        failClosed: true
      };
    }
    if (observedNode.keyStatus !== "active") {
      return {
        ok: false,
        code: "tier4.overlay.key-lost",
        reason: `overlay node ${expectedNode.nodeId} lost its mesh key`,
        failClosed: true
      };
    }
    if (isJsonString(observedNode.segmentId) && observedNode.segmentId.length > 0) {
      segments.add(observedNode.segmentId);
    }
  }

  if (segments.size > 1) {
    return {
      ok: false,
      code: "tier4.overlay.partitioned",
      reason: "overlay mesh nodes are partitioned across segments",
      failClosed: true
    };
  }

  return { ok: true };
}

export function planOverlayNodeLifecycle(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    return invalid("tier4.lifecycle.invalid", "input must be an object");
  }
  const nodeId = input.nodeId;
  if (!isJsonString(nodeId) || nodeId.length === 0) {
    return invalid("tier4.lifecycle.invalid", "nodeId must be a non-empty string");
  }
  const current = input.current;
  const desired = input.desired;
  if (!isLifecycleState(current?.state) || !isLifecycleState(desired?.state)) {
    return invalid("tier4.lifecycle.invalid", "current.state and desired.state must be valid lifecycle states");
  }
  if (input.publicFallbackRequested === true) {
    return {
      ok: false,
      code: "tier4.lifecycle.public-fallback-forbidden",
      reason: `overlay node ${nodeId} cannot use public fallback during lifecycle repair`,
      failClosed: true
    };
  }

  const currentEpoch = current.keyEpoch ?? 0;
  const desiredEpoch = desired.keyEpoch ?? currentEpoch;
  if (!Number.isInteger(currentEpoch) || !Number.isInteger(desiredEpoch) || currentEpoch < 0 || desiredEpoch < 0) {
    return invalid("tier4.lifecycle.invalid", "key epochs must be non-negative integers");
  }
  if (desiredEpoch < currentEpoch) {
    return {
      ok: false,
      code: "tier4.lifecycle.key-regression",
      reason: `overlay node ${nodeId} cannot move from key epoch ${currentEpoch} to ${desiredEpoch}`,
      failClosed: true
    };
  }

  if (current.state === "missing" && desired.state === "active") {
    return lifecycle("create", ["overlay.NodeCreated"]);
  }
  if (current.state === "active" && desired.state === "active" && desiredEpoch > currentEpoch) {
    return lifecycle("rotate-key", ["overlay.NodeKeyRotated"]);
  }
  if (current.state === "active" && desired.state === "retired" && (input.activePeers ?? 0) > 0) {
    return lifecycle("drain", ["overlay.NodeDraining"]);
  }
  if ((current.state === "active" || current.state === "draining") && desired.state === "retired" && (input.activePeers ?? 0) === 0) {
    return lifecycle("retire", ["overlay.NodeRetired"]);
  }
  if (current.state === desired.state && desiredEpoch === currentEpoch) {
    return lifecycle("noop", []);
  }

  return {
    ok: false,
    code: "tier4.lifecycle.unsupported-transition",
    reason: `overlay node ${nodeId} cannot transition from ${current.state} to ${desired.state}`,
    failClosed: true
  };
}

function validateTierFourPlan(plan) {
  const validation = validateConnectivityPlan(plan);
  if (!validation.ok) return validation;

  if (plan.tier !== ConnectivityTier.OVERLAY_MESH) {
    return invalid(
      "tier4.plan.unsupported-tier",
      "tier 4 realization requires ConnectivityTier.OVERLAY_MESH"
    );
  }

  if (plan.source.provider === plan.target.provider) {
    return invalid("tier4.plan.provider-match", "tier 4 requires source and target in different providers");
  }

  for (const [field, value] of [
    ["parameters.meshKind", plan.parameters.meshKind],
    ["parameters.meshPolicyRef", plan.parameters.meshPolicyRef]
  ]) {
    if (!isJsonString(value) || value.length === 0) {
      return invalid("tier4.plan.overlay-parameter-missing", `${field} must be a non-empty string`);
    }
  }
  if (plan.parameters.meshKind !== WIREGUARD_EBPF_MESH_KIND) {
    return invalid("tier4.plan.unsupported-mesh-kind", "tier 4 overlay meshKind must be wireguard-ebpf");
  }

  if (plan.parameters.fallbackFromTier === undefined || plan.parameters.fallbackReason === undefined) {
    return invalid(
      "tier4.plan.invalid-fallback",
      "tier 4 overlay realization requires an explicit tier 3 fall-through"
    );
  }
  if (plan.parameters.fallbackFromTier !== ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT) {
    return invalid("tier4.plan.invalid-fallback", "tier 4 overlay fallback must come from tier 3");
  }
  if (!isJsonString(plan.parameters.fallbackReason) || plan.parameters.fallbackReason.length === 0) {
    return invalid("tier4.plan.invalid-fallback", "parameters.fallbackReason must explain the tier 3 fall-through");
  }

  return { ok: true };
}

function validateResidencyBoundary(plan) {
  const residency = plan.residency;
  if (residency === undefined) return { ok: true };

  if (residency.allowedProviders !== undefined) {
    if (!isStringArray(residency.allowedProviders)) {
      return invalid("tier4.residency.invalid", "residency.allowedProviders must contain non-empty provider strings");
    }
    if (!residency.allowedProviders.includes(plan.source.provider) || !residency.allowedProviders.includes(plan.target.provider)) {
      return invalid(
        "tier4.residency.forbidden-provider",
        `residency tag ${residency.tag} does not allow ${plan.source.provider}->${plan.target.provider}`
      );
    }
  }

  if (residency.allowedRegions !== undefined) {
    if (!isStringArray(residency.allowedRegions)) {
      return invalid("tier4.residency.invalid", "residency.allowedRegions must contain non-empty region strings");
    }
    if (!residency.allowedRegions.includes(plan.source.region) || !residency.allowedRegions.includes(plan.target.region)) {
      return invalid(
        "tier4.residency.forbidden-region",
        `residency tag ${residency.tag} allows ${residency.allowedRegions.join(", ")} but edge crosses ${plan.source.region}->${plan.target.region}`
      );
    }
  }

  return { ok: true };
}

function resolveOverlayNodes(overlayNodeCatalog, plan) {
  if (!Array.isArray(overlayNodeCatalog)) {
    return invalid("tier4.overlay-catalog.invalid", "overlayNodeCatalog must be an array");
  }

  const sourceNode = findOverlayNode(overlayNodeCatalog, plan.source, plan.parameters.meshKind);
  if (!sourceNode) {
    return invalid("tier4.overlay-node.missing", `overlay node missing for ${plan.source.provider}/${plan.source.region}`);
  }
  const targetNode = findOverlayNode(overlayNodeCatalog, plan.target, plan.parameters.meshKind);
  if (!targetNode) {
    return invalid("tier4.overlay-node.missing", `overlay node missing for ${plan.target.provider}/${plan.target.region}`);
  }

  for (const node of [sourceNode, targetNode]) {
    for (const field of ["nodeId", "provider", "region", "yardId", "meshKind"]) {
      if (!isJsonString(node[field]) || node[field].length === 0) {
        return invalid("tier4.overlay-catalog.invalid", `overlay node ${field} must be a non-empty string`);
      }
    }
    if (node.publicFallbackAllowed === true) {
      return invalid("tier4.overlay.public-fallback-forbidden", "tier 4 overlay nodes must not allow public fallback");
    }
  }

  return {
    ok: true,
    nodes: [sourceNode, targetNode].map((node) => ({
      nodeId: node.nodeId,
      provider: node.provider,
      region: node.region,
      yardId: node.yardId,
      meshKind: node.meshKind,
      publicFallbackAllowed: false
    }))
  };
}

function findOverlayNode(catalog, endpoint, meshKind) {
  return catalog.find((node) => (
    node?.provider === endpoint.provider &&
    node?.region === endpoint.region &&
    node?.yardId === endpoint.yardId &&
    node?.meshKind === meshKind
  ));
}

function resolveBindingFromOutputs(plan, providerOutputs) {
  return resolveBindingForResource({
    targetResourceId: plan.target.resourceId,
    sourceResourceId: plan.source.resourceId,
    binding: plan.endpoints.targetLogicalName,
    sourceProvider: plan.source.provider,
    targetProvider: plan.target.provider,
    providerOutputs
  });
}

function resolveBindingForResource({
  targetResourceId,
  sourceResourceId,
  binding,
  sourceProvider,
  targetProvider,
  providerOutputs
}) {
  if (!providerOutputs || !isJsonObject(providerOutputs) || Array.isArray(providerOutputs)) {
    return invalid("tier4.provider-outputs.invalid", "providerOutputs must be an object keyed by resource id");
  }

  const outputs = providerOutputs[targetResourceId];
  if (!outputs || !isJsonObject(outputs) || Array.isArray(outputs)) {
    return invalid("tier4.endpoint.missing", `provider outputs missing for ${targetResourceId}`);
  }

  const endpoint = outputs[DEFAULT_PROVIDER_OUTPUT_KEY];
  if (!isJsonString(endpoint) || endpoint.length === 0) {
    return invalid("tier4.endpoint.missing", `${targetResourceId}.${DEFAULT_PROVIDER_OUTPUT_KEY} must be a non-empty string`);
  }

  return {
    ok: true,
    binding: {
      binding,
      targetResourceId,
      endpoint,
      sourceResourceId,
      providerOutputKey: DEFAULT_PROVIDER_OUTPUT_KEY,
      sourceProvider,
      targetProvider
    }
  };
}

function normalizeVerbs(verbs = ["connect"]) {
  if (!Array.isArray(verbs) || verbs.length === 0) {
    return invalid("tier4.verbs.invalid", "verbs must be a non-empty array");
  }
  const seen = new Set();
  const normalized = [];
  for (const verb of verbs) {
    if (!isJsonString(verb) || verb.length === 0) {
      return invalid("tier4.verbs.invalid", "verbs entries must be non-empty strings");
    }
    if (!seen.has(verb)) {
      seen.add(verb);
      normalized.push(verb);
    }
  }
  return { ok: true, value: normalized };
}

function isLifecycleState(value) {
  return VALID_LIFECYCLE_STATES.has(value);
}

function lifecycle(action, events) {
  return {
    ok: true,
    action,
    events,
    publicFallbackAllowed: false
  };
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => isJsonString(entry) && entry.length > 0);
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
