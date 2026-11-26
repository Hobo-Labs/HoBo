import { isJsonObject } from "./json.js";
export const AVAILABILITY_VIEW_VERSION = "hobo.availability-view/v1";

const DEFAULT_HOP_AVAILABILITY = 1;
const DEFAULT_UNRATED_AVAILABILITY = 0.95;
const DEFAULT_DIVERGENCE_THRESHOLD = 0.02;

export function computeAvailabilityView({
  graph,
  observedAvailability = null,
  availabilitySlo = null,
  conservativeUnratedAvailability = DEFAULT_UNRATED_AVAILABILITY,
  divergenceThreshold = DEFAULT_DIVERGENCE_THRESHOLD,
} = {}) {
  const warnings = [];
  const errors = [];
  const breakdown = {
    byNode: {},
    countedNodes: [],
  };

  if (!graph || !graph.root || !graph.nodes || !isJsonObject(graph.nodes)) {
    return invalidView({
      code: "invalid-graph",
      message: "graph requires root and nodes",
      observedAvailability,
      availabilitySlo,
    });
  }

  const context = {
    graph,
    warnings,
    breakdown,
    countedPhysicalNodes: new Set(),
    countedVirtualNodes: new Set(),
    conservativeUnratedAvailability,
    defaultHopAvailability: normalizeAvailability(
      graph.defaultHopAvailability ?? DEFAULT_HOP_AVAILABILITY,
      "defaultHopAvailability",
    ),
  };

  let estimatedAvailability;
  try {
    estimatedAvailability = roundRatio(estimateNode(graph.root, context, []));
  } catch (error) {
    errors.push({
      code: error.code ?? "invalid-graph",
      message: error.message,
    });
  }

  if (errors.length > 0) {
    return {
      schema: AVAILABILITY_VIEW_VERSION,
      status: "invalid-graph",
      estimatedAvailability: null,
      estimatedDowntimeMinutesPerYear: null,
      observedAvailability,
      availabilitySlo,
      summary: makeSummary(null, observedAvailability),
      canDeploy: {
        effect: "warn",
        warnings: errors.map((error) => ({
          code: error.code,
          message: error.message,
          hardGate: false,
        })),
      },
      warnings,
      errors,
      breakdown,
    };
  }

  if (observedAvailability !== null) {
    const observed = normalizeAvailability(observedAvailability, "observedAvailability");
    const gap = Math.abs(estimatedAvailability - observed);
    if (gap >= divergenceThreshold) {
      warnings.push({
        code: "estimate-observed-divergence",
        message: "observed availability diverges from architecture-derived estimate",
        estimatedAvailability,
        observedAvailability: observed,
        gap: roundRatio(gap),
      });
    }
  }

  const canDeployWarnings = [];
  if (availabilitySlo !== null) {
    const floor = normalizeAvailability(availabilitySlo, "availabilitySlo");
    if (estimatedAvailability < floor) {
      canDeployWarnings.push({
        code: "availability-floor-unmet",
        message: "architecture-derived estimate is below availabilitySlo; warn only",
        hardGate: false,
        estimatedAvailability,
        availabilitySlo: floor,
      });
    }
  }

  return {
    schema: AVAILABILITY_VIEW_VERSION,
    status: "estimated",
    estimatedAvailability,
    estimatedDowntimeMinutesPerYear: roundDecimal((1 - estimatedAvailability) * 525_600, 3),
    observedAvailability,
    availabilitySlo,
    summary: makeSummary(estimatedAvailability, observedAvailability),
    canDeploy: {
      effect: canDeployWarnings.length > 0 ? "warn" : "allow",
      warnings: canDeployWarnings,
    },
    warnings,
    errors,
    breakdown,
  };
}

export function formatAvailabilityPercent(value) {
  if (value === null || value === undefined) {
    return "unknown";
  }
  return `${(normalizeAvailability(value, "availability") * 100).toFixed(3)}%`;
}

function estimateNode(id, context, path) {
  if (path.includes(id)) {
    const error = new Error(`cycle detected: ${[...path, id].join(" -> ")}`);
    error.code = "cycle-detected";
    throw error;
  }

  const node = context.graph.nodes[id];
  if (!node) {
    const error = new Error(`missing node: ${id}`);
    error.code = "missing-node";
    throw error;
  }

  const nextPath = [...path, id];
  let availability;

  if (node.type === "redundant-set") {
    availability = estimateRedundantSet(id, node, context, nextPath);
  } else {
    availability = estimateComponentNode(id, node, context, nextPath);
  }

  const rounded = roundRatio(availability);
  if (!context.breakdown.byNode[id]) {
    context.breakdown.byNode[id] = {
      type: node.type ?? "component",
      availability: rounded,
    };
  }
  return rounded;
}

function estimateComponentNode(id, node, context, path) {
  const base = resolveComponentAvailability(id, node, context);
  const dependencies = node.dependsOn ?? [];
  if (!Array.isArray(dependencies)) {
    const error = new Error(`node ${id} dependsOn must be an array`);
    error.code = "invalid-dependency-list";
    throw error;
  }

  let availability = base;
  for (const dependency of dependencies) {
    availability *= context.defaultHopAvailability;
    availability *= estimateNode(dependency, context, path);
  }

  return availability;
}

function estimateRedundantSet(id, node, context, path) {
  if (context.countedVirtualNodes.has(id)) {
    return 1;
  }
  context.countedVirtualNodes.add(id);

  if (!Array.isArray(node.members) || node.members.length === 0) {
    const error = new Error(`redundant set ${id} requires members`);
    error.code = "invalid-redundant-set";
    throw error;
  }

  const memberAvailabilities = node.members.map((member) => estimateNode(member, context, path));
  let availability = 1 - memberAvailabilities.reduce((unavailable, member) => unavailable * (1 - member), 1);

  if (Array.isArray(node.sharedDependencies) && node.sharedDependencies.length > 0) {
    context.warnings.push({
      code: "redundancy-shared-failure-domain",
      message: "redundant set has shared dependencies that bound the parallel gain",
      node: id,
      sharedDependencies: [...node.sharedDependencies],
    });
    for (const dependency of node.sharedDependencies) {
      availability *= estimateNode(dependency, context, path);
    }
  }

  return availability;
}

function resolveComponentAvailability(id, node, context) {
  if (context.countedPhysicalNodes.has(id)) {
    return 1;
  }

  context.countedPhysicalNodes.add(id);
  context.breakdown.countedNodes.push(id);

  if (node.availability === undefined) {
    context.warnings.push({
      code: "unrated-provider",
      message: "provider/resource SLA is unrated; conservative default used",
      node: id,
      provider: node.provider ?? id,
      assumedAvailability: context.conservativeUnratedAvailability,
    });
    return normalizeAvailability(context.conservativeUnratedAvailability, "conservativeUnratedAvailability");
  }

  return normalizeAvailability(node.availability, `nodes.${id}.availability`);
}

function makeSummary(estimatedAvailability, observedAvailability) {
  const observed = observedAvailability === null ? null : normalizeAvailability(observedAvailability, "observedAvailability");
  const gap = estimatedAvailability === null || observed === null ? null : Math.abs(estimatedAvailability - observed);
  return {
    estimated: formatAvailabilityPercent(estimatedAvailability),
    observed: formatAvailabilityPercent(observed),
    estimateObservedGap: formatAvailabilityPercent(gap),
  };
}

function invalidView({ code, message, observedAvailability, availabilitySlo }) {
  return {
    schema: AVAILABILITY_VIEW_VERSION,
    status: "invalid-graph",
    estimatedAvailability: null,
    estimatedDowntimeMinutesPerYear: null,
    observedAvailability,
    availabilitySlo,
    summary: makeSummary(null, observedAvailability),
    canDeploy: {
      effect: "warn",
      warnings: [{ code, message, hardGate: false }],
    },
    warnings: [],
    errors: [{ code, message }],
    breakdown: {
      byNode: {},
      countedNodes: [],
    },
  };
}

function normalizeAvailability(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${field} must be a number from 0 to 1`);
  }
  return number;
}

function roundRatio(value) {
  return roundDecimal(value, 6);
}

function roundDecimal(value, places) {
  return Number(value.toFixed(places));
}
