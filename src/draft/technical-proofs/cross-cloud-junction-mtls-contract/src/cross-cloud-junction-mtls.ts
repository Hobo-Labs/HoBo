import { isJsonString, isJsonObject } from "./json.js";
import { ConnectivityTier, decideConnectivityTier } from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import { enforceConnectivityCanDeploy } from "../../connectivity-policy-enforcement-contract/src/connectivity-policy-enforcement.js";
import {  estimateConnectivityFeedback  } from "../../connectivity-cost-feedback-contract/src/connectivity-cost-feedback.js";
import { evaluateMtlsHandshake } from "../../mtls-data-path-contract/src/mtls-data-path.js";
import {  planJunctionConnectivity,
  validateJunctionConnectivityPlan
} from "../../junction-connectivity-plan-contract/src/junction-connectivity-plan.js";
import { projectYardManifest } from "../../yard-topology-manifest-contract/src/yard-topology-manifest.js";
import { junction as topologyJunction } from "../../topology-objects-contract/src/topology-objects.js";

export const CROSS_CLOUD_JUNCTION_SCHEMA_VERSION = "hobo.cross-cloud-junction/v1";
export { ConnectivityTier, topologyJunction as junction };

export function planCrossCloudJunction(input) {
  const parsed = parseCrossCloudInput(input);
  if (!parsed.ok) return parsed;

  const { junctionObject, bindEdges, environment, policyDecision, costCatalog, latencyCatalog, tierCapabilities } =
    parsed.value;

  const edgePlans = [];
  const annotatedEdges = [];
  const policyResults = [];

  for (const edge of bindEdges) {
    const tierDecision = decideConnectivityTier(edge);
    if (!tierDecision.ok) {
      return tierDecision;
    }

    const policyGate = enforceConnectivityCanDeploy({
      plan: tierDecision.plan,
      environment,
      policyDecision
    });
    policyResults.push({ edgeId: edge.edgeId, policyGate });

    if (!policyGate.ok) {
      return {
        ok: false,
        code: policyGate.code,
        reason: policyGate.reason,
        edgeId: edge.edgeId,
        policyGate,
        junction: junctionObject
      };
    }

    const feedback = estimateConnectivityFeedback({
      plan: tierDecision.plan,
      costCatalog,
      latencyCatalog
    });
    if (!feedback.ok) {
      return feedback;
    }

    edgePlans.push(tierDecision.plan);
    annotatedEdges.push(feedback.topologyAnnotation);
  }

  const members = parsed.value.yardTopologies.map((topology) => ({
    manifest: projectYardManifest(topology)
  }));

  const junctionPlanResult = planJunctionConnectivity({
    junctionId: junctionObject.name,
    members,
    tierCapabilities
  });
  if (!junctionPlanResult.ok) {
    return junctionPlanResult;
  }

  const junctionValidation = validateJunctionConnectivityPlan(junctionPlanResult.plan);
  if (!junctionValidation.ok) {
    return junctionValidation;
  }

  return {
    ok: true,
    schemaVersion: CROSS_CLOUD_JUNCTION_SCHEMA_VERSION,
    outcome: "deployable",
    junction: junctionObject,
    edgePlans,
    annotatedEdges,
    policyResults,
    junctionConnectivity: {
      plan: junctionPlanResult.plan,
      validation: junctionValidation,
      deliveryYards: Object.keys(junctionPlanResult.plan.deliveriesByYard),
      sharedStateWrites: junctionPlanResult.plan.sharedStateWrites
    }
  };
}

export function invokeCrossCloudService({ planResult, mtlsHandshake, request = {} }) {
  if (!planResult?.ok) {
    return invalid("cross-cloud.plan.not-deployable", "cross-cloud plan must be deployable before invoke");
  }
  if (planResult.outcome !== "deployable") {
    return invalid("cross-cloud.plan.not-deployable", `plan outcome is ${planResult.outcome}`);
  }
  if (planResult.junctionConnectivity?.sharedStateWrites?.length !== 0) {
    return invalid("cross-cloud.shared-state.forbidden", "Junction must not write shared mutable state");
  }

  const mtls = evaluateMtlsHandshake(mtlsHandshake);
  if (!mtls.ok) {
    return mtls;
  }

  const edgePlan = planResult.edgePlans[0];
  if (!edgePlan) {
    return invalid("cross-cloud.edge.missing", "plan must include at least one bind edge");
  }

  const sourceProvider = edgePlan.source.provider;
  const targetProvider = edgePlan.target.provider;
  if (sourceProvider === targetProvider) {
    return invalid("cross-cloud.provider.same", "cross-cloud invoke requires different source and target providers");
  }

  return {
    ok: true,
    transport: "mtls",
    tier: edgePlan.tier,
    source: {
      provider: sourceProvider,
      yardId: edgePlan.source.yardId,
      resourceId: edgePlan.source.resourceId,
      svid: mtls.source
    },
    target: {
      provider: targetProvider,
      yardId: edgePlan.target.yardId,
      resourceId: edgePlan.target.resourceId,
      svid: mtls.peer
    },
    authz: mtls.authz,
    response: {
      status: request.expectedStatus ?? 200,
      body: request.responseBody ?? { ok: true }
    },
    annotatedEdge: planResult.annotatedEdges.find((entry) => entry.edgeId === edgePlan.edgeId)
  };
}

function parseCrossCloudInput(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    return invalid("cross-cloud.input.invalid", "input must be an object");
  }

  const junctionObject = input.junction;
  if (junctionObject?.kind !== "junction") {
    return invalid("cross-cloud.junction.invalid", "junction must be a topology Junction object");
  }
  if (junctionObject.yards.length < 2) {
    return invalid("cross-cloud.junction.peers", "cross-cloud junction requires at least two peer Yards");
  }

  const providerIds = new Set(junctionObject.providerIds);
  if (providerIds.size < 2) {
    return invalid("cross-cloud.junction.providers", "cross-cloud junction requires Yards on different providers");
  }

  const bindEdges = input.bindEdges;
  if (!Array.isArray(bindEdges) || bindEdges.length === 0) {
    return invalid("cross-cloud.edges.required", "bindEdges must be a non-empty array");
  }

  const yardTopologies = input.yardTopologies;
  if (!Array.isArray(yardTopologies) || yardTopologies.length !== junctionObject.yards.length) {
    return invalid("cross-cloud.yards.invalid", "yardTopologies must match junction yard count");
  }

  if (!isJsonString(input.environment) || input.environment.length === 0) {
    return invalid("cross-cloud.environment.required", "environment must be a non-empty string");
  }

  const policyDecision = input.policyDecision;
  if (!policyDecision || policyDecision.phase !== "can-deploy") {
    return invalid("cross-cloud.policy.invalid", "policyDecision.phase must be can-deploy");
  }

  return {
    ok: true,
    value: {
      junctionObject,
      bindEdges,
      yardTopologies,
      environment: input.environment,
      policyDecision,
      costCatalog: input.costCatalog ?? defaultCostCatalog(),
      latencyCatalog: input.latencyCatalog ?? defaultLatencyCatalog(),
      tierCapabilities: input.tierCapabilities ?? defaultTierCapabilities(yardTopologies)
    }
  };
}

function defaultCostCatalog() {
  return {
    egressPerGbByTier: {
      [ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT]: { default: 0.02 },
      [ConnectivityTier.OVERLAY_MESH]: { default: 0.05 },
      [ConnectivityTier.PUBLIC_MTLS]: { default: 0.12 }
    }
  };
}

function defaultLatencyCatalog() {
  return {
    latencyMsP50ByTier: {
      [ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT]: { default: 18 },
      [ConnectivityTier.OVERLAY_MESH]: { default: 32 },
      [ConnectivityTier.PUBLIC_MTLS]: { default: 45 }
    }
  };
}

function defaultTierCapabilities(yardTopologies) {
  const yardIds = yardTopologies.map((topology) => topology.yard.id);
  if (yardIds.length < 2) return [];
  return [
    {
      sourceYardId: yardIds[0],
      targetYardId: yardIds[1],
      supportedTiers: [ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT]
    },
    {
      sourceYardId: yardIds[1],
      targetYardId: yardIds[0],
      supportedTiers: [ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT]
    }
  ];
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}
