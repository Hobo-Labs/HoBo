import { isJsonNumber } from "./json.js";
export function evaluateCostRoutingPlan({
  domain,
  routes = [],
  resources = [],
  camps = [],
  previousDecisions = {},
  hysteresis = {},
}) {
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const usableCamps = camps.filter(isUsableCamp);
  const events = [];
  const violations = [];

  const plannedRoutes = routes.map((route) => {
    const reachableResourceIds = collectReachableResourceIds(route.entryResourceIds ?? [], resourceById);
    const singleWriterResourceIds = reachableResourceIds.filter((resourceId) =>
      isSingleWriter(resourceById.get(resourceId)),
    );
    const ineligibleResourceIds = reachableResourceIds.filter((resourceId) =>
      isCostIneligible(resourceById.get(resourceId)),
    );

    if (route.policy?.kind === "home") {
      return homeRouted(route, reachableResourceIds, "explicit home route");
    }

    if (route.policy?.kind !== "cost") {
      throw new Error(`unsupported route policy for ${route.routeId}: ${route.policy?.kind ?? "missing"}`);
    }

    if (ineligibleResourceIds.length > 0) {
      const allIneligibleResourcesAreSingleWriter =
        singleWriterResourceIds.length === ineligibleResourceIds.length;
      const reason = allIneligibleResourcesAreSingleWriter
        ? `cost routing reaches single-writer resources: ${singleWriterResourceIds.join(", ")}`
        : `cost routing reaches cost-ineligible resources: ${ineligibleResourceIds.join(", ")}`;
      const routeReason = allIneligibleResourcesAreSingleWriter
        ? `route reaches single-writer resources: ${singleWriterResourceIds.join(", ")}`
        : `route reaches cost-ineligible resources: ${ineligibleResourceIds.join(", ")}`;
      violations.push({
        routeId: route.routeId,
        reason,
        singleWriterResourceIds,
        reachableResourceIds,
      });
      return homeRouted(route, reachableResourceIds, routeReason);
    }

    const decision = chooseCostTarget({
      route,
      usableCamps,
      previousDecision: previousDecisions[route.routeId],
      minimumSavingsFraction: hysteresis.minimumSavingsFraction ?? 0,
    });

    if (decision.changed) {
      events.push({
        type: "domain.RoutingChanged",
        domain,
        routeId: route.routeId,
        data: {
          policy: "cost",
          targetCamp: decision.targetCamp,
          previousTargetCamp: decision.previousTargetCamp,
          reason: decision.reason,
        },
      });
    }

    return {
      routeId: route.routeId,
      path: route.path,
      status: decision.status,
      targetCamp: decision.targetCamp,
      policy: { kind: "cost", camp: decision.targetCamp },
      reachableResourceIds,
      reason: decision.reason,
    };
  });

  return {
    domain,
    resources,
    canDeploy: {
      allowed: violations.length === 0,
      violations,
    },
    routes: plannedRoutes,
    events,
  };
}

export function assertNoSingleWriterCostRoutes(plan) {
  const resourceById = new Map((plan.resources ?? []).map((resource) => [resource.id, resource]));

  for (const route of plan.routes ?? []) {
    if (route.policy?.kind !== "cost") {
      continue;
    }

    const singleWriterResourceIds = (route.reachableResourceIds ?? []).filter((resourceId) =>
      isSingleWriter(resourceById.get(resourceId)),
    );

    if (singleWriterResourceIds.length > 0) {
      throw new Error(
        `${route.routeId} cost-routes single-writer resources: ${singleWriterResourceIds.join(", ")}`,
      );
    }
  }

  return true;
}

function homeRouted(route, reachableResourceIds, reason) {
  return {
    routeId: route.routeId,
    path: route.path,
    status: "home-routed",
    targetCamp: route.homeCamp,
    policy: { kind: "home", camp: route.homeCamp },
    reachableResourceIds,
    reason,
  };
}

function chooseCostTarget({ route, usableCamps, previousDecision, minimumSavingsFraction }) {
  const allowedCampNames = route.targetCamps ? new Set(route.targetCamps) : null;
  const candidateCamps = usableCamps
    .filter((camp) => allowedCampNames === null || allowedCampNames.has(camp.camp))
    .sort(
      (left, right) =>
        left.effectiveMarginalCost - right.effectiveMarginalCost || left.camp.localeCompare(right.camp),
    );

  if (candidateCamps.length === 0) {
    throw new Error(`cost route ${route.routeId} has no healthy validated Camp candidates`);
  }

  const cheapestCamp = candidateCamps[0];
  const previousTargetCamp = previousDecision?.targetCamp;
  const previousCamp = candidateCamps.find((camp) => camp.camp === previousTargetCamp);

  if (previousCamp && cheapestCamp.camp !== previousCamp.camp && minimumSavingsFraction > 0) {
    const savingsFraction =
      (previousCamp.effectiveMarginalCost - cheapestCamp.effectiveMarginalCost) /
      previousCamp.effectiveMarginalCost;

    if (savingsFraction < minimumSavingsFraction) {
      return {
        status: "cost-held",
        targetCamp: previousCamp.camp,
        previousTargetCamp,
        changed: false,
        reason: `${cheapestCamp.camp} is ${formatPercent(savingsFraction)} cheaper than ${previousCamp.camp}, below ${formatPercent(minimumSavingsFraction)} hysteresis`,
      };
    }

    return {
      status: "cost-routed",
      targetCamp: cheapestCamp.camp,
      previousTargetCamp,
      changed: true,
      reason: `${cheapestCamp.camp} is ${formatPercent(savingsFraction)} cheaper than ${previousCamp.camp}, exceeding ${formatPercent(minimumSavingsFraction)} hysteresis`,
    };
  }

  return {
    status: previousTargetCamp === cheapestCamp.camp ? "cost-held" : "cost-routed",
    targetCamp: cheapestCamp.camp,
    previousTargetCamp,
    changed: previousTargetCamp !== cheapestCamp.camp,
    reason: `cheapest healthy Camp is ${cheapestCamp.camp} at ${cheapestCamp.effectiveMarginalCost}`,
  };
}

function collectReachableResourceIds(entryResourceIds, resourceById) {
  const reachableResourceIds = [];
  const seen = new Set();

  for (const resourceId of entryResourceIds) {
    visitResource(resourceId, resourceById, seen, reachableResourceIds);
  }

  return reachableResourceIds;
}

function visitResource(resourceId, resourceById, seen, reachableResourceIds) {
  if (seen.has(resourceId)) {
    return;
  }

  seen.add(resourceId);
  reachableResourceIds.push(resourceId);

  for (const dependencyId of resourceById.get(resourceId)?.dependencies ?? []) {
    visitResource(dependencyId, resourceById, seen, reachableResourceIds);
  }
}

function isUsableCamp(camp) {
  return camp.healthy !== false && camp.validated !== false && isJsonNumber(camp.effectiveMarginalCost);
}

function isCostIneligible(resource) {
  return !["active-active-eventual", "pinned"].includes(resource?.replicaTopology);
}

function isSingleWriter(resource) {
  return resource?.replicaTopology === "single-writer";
}

function formatPercent(fraction) {
  return `${(fraction * 100).toFixed(2)}%`;
}
