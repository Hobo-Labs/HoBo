import { isJsonObject } from "./json.js";
export const CONTRACT_VERSION = "hobo.reliability-sla-rollup/v1";

const BUILT_IN_TARGETS = [
  {
    id: "control-plane-availability-single-region",
    kind: "availability",
    objective: 0.999,
    comparator: ">=",
    sliSource: "control-plane-availability",
  },
  {
    id: "control-plane-availability-multi-region",
    kind: "availability",
    objective: 0.9995,
    comparator: ">=",
    sliSource: "control-plane-availability",
    minFailureDomains: 2,
  },
  {
    id: "deploy-resume-after-node-loss",
    kind: "duration",
    objectiveSeconds: 30,
    comparator: "<",
    sliSource: "deploy-resume-after-node-loss",
  },
  {
    id: "rpo-sync-quorum",
    kind: "duration",
    objectiveSeconds: 0,
    comparator: "~0",
    sliSource: "rpo-sync-quorum",
  },
  {
    id: "rpo-async-tier",
    kind: "duration",
    objectiveSeconds: 5,
    comparator: "<=",
    sliSource: "rpo-async-tier",
  },
  {
    id: "rto-full-yard-rebuild",
    kind: "duration",
    objectiveSeconds: 900,
    comparator: "<",
    sliSource: "rto-full-yard-rebuild",
  },
];

export function ratifyReliabilityTargets(evidence = {}) {
  const items = BUILT_IN_TARGETS.map((target) => {
    const warnings = [];
    const source = evidence.sloSources?.[target.sliSource];

    if (!source) {
      warnings.push("missing-slo-source");
    }

    if (target.kind === "availability") {
      const estimate = evidence.availabilityView?.[target.id];

      if (!estimate) {
        warnings.push("missing-availability-estimate");
      } else {
        if (estimate.estimatedAvailability < target.objective) {
          warnings.push("availability-estimate-below-objective");
        }

        const failureDomains = new Set(estimate.declaredFailureDomains ?? []);
        if (target.minFailureDomains && failureDomains.size < target.minFailureDomains) {
          warnings.push("multi-region-target-has-undeclared-shared-failure-domain");
        }
      }
    }

    if (target.id === "rto-full-yard-rebuild") {
      const drill = evaluateRestoreDrill(evidence.restoreDrill ?? {});
      if (!drill.ok) {
        warnings.push(drill.reason ?? "restore-drill-breached-target");
      }
    }

    return {
      id: target.id,
      kind: target.kind,
      ratification: warnings.length === 0 ? "ratified" : "provisional",
      assertion: {
        measuredBy: source?.port ?? null,
        sliSource: target.sliSource,
        objective: target.objective ?? target.objectiveSeconds,
        comparator: target.comparator,
        window: source?.window ?? null,
      },
      warnings,
    };
  });

  return {
    contract: CONTRACT_VERSION,
    items,
  };
}

export function evaluateRestoreDrill({
  measuredSeconds,
  targetSeconds,
  replayedEvents,
  minProductionEvents,
} = {}) {
  assertFiniteNumber(measuredSeconds, "measuredSeconds");
  assertFiniteNumber(targetSeconds, "targetSeconds");
  assertFiniteNumber(replayedEvents, "replayedEvents");
  assertFiniteNumber(minProductionEvents, "minProductionEvents");

  const productionScale = replayedEvents >= minProductionEvents;
  if (!productionScale) {
    return {
      ok: false,
      status: "provisional",
      measuredSeconds,
      targetSeconds,
      productionScale,
      reason: "restore-drill-not-production-scale",
    };
  }

  if (measuredSeconds >= targetSeconds) {
    return {
      ok: false,
      status: "breached",
      measuredSeconds,
      targetSeconds,
      productionScale,
      reason: "restore-drill-exceeded-rto-target",
    };
  }

  return {
    ok: true,
    status: "passed",
    measuredSeconds,
    targetSeconds,
    productionScale,
    reason: null,
  };
}

export function foldReliabilityRollup(events = []) {
  const sortedEvents = [...events].sort((left, right) => left.seq - right.seq);
  const rollup = {
    contract: CONTRACT_VERSION,
    eventIds: [],
    environments: {},
    statusPage: {},
  };

  for (const event of sortedEvents) {
    assertEvent(event);
    rollup.eventIds.push(event.id);

    const env = ensureEnvironment(rollup, event.data.project, event.data.environment);

    switch (event.type) {
      case "sla.TargetRatified":
        env.targets[event.data.targetId] = {
          ...(env.targets[event.data.targetId]),
          targetId: event.data.targetId,
          objective: event.data.objective,
          ratification: "ratified",
          evidenceEventId: event.id,
        };
        break;
      case "availability.Estimated":
        env.targets[event.data.targetId] = {
          ...(env.targets[event.data.targetId]),
          targetId: event.data.targetId,
          estimatedAvailability: event.data.estimatedAvailability,
          estimatedAnnualDowntimeMinutes: event.data.estimatedAnnualDowntimeMinutes,
          weakestLinkPath: event.data.weakestLinkPath ?? [],
          availabilityEstimateEventId: event.id,
        };
        break;
      case "slo.Measured":
        env.targets[event.data.targetId] = {
          ...(env.targets[event.data.targetId]),
          targetId: event.data.targetId,
          observedAvailability: event.data.observedAvailability,
          window: event.data.window,
          fresh: event.data.fresh === true,
          observedEventId: event.id,
        };
        if (
          env.targets[event.data.targetId].objective !== undefined &&
          event.data.observedAvailability < env.targets[event.data.targetId].objective
        ) {
          env.incidents.push({
            id: `incident-${event.id}`,
            class: "sla-target-breach",
            component: event.data.targetId,
            targetId: event.data.targetId,
            tenantScoped: false,
          });
        }
        break;
      case "incident.Opened":
        env.incidents.push({
          id: event.id,
          class: event.data.class,
          component: event.data.component,
          targetId: event.data.targetId,
          tenantScoped: event.data.tenantScoped === true,
        });
        break;
      case "dr.RestoreDrilled":
        env.restoreDrill = evaluateRestoreDrill(event.data);
        if (!env.restoreDrill.ok) {
          env.incidents.push({
            id: event.id,
            class: "rto-target-breach",
            component: "yard-restore",
            targetId: "rto-full-yard-rebuild",
            tenantScoped: false,
          });
        }
        break;
      case "statuspage.Published":
        env.publication = {
          eventId: event.id,
          allowlist: event.data.allowlist ?? [],
          redactionProfile: event.data.redactionProfile,
          contentHash: event.data.contentHash,
        };
        break;
      case "statuspage.Unpublished":
        env.publication = null;
        break;
      default:
        throw new Error(`unsupported reliability event type: ${event.type}`);
    }
  }

  for (const [environment, env] of Object.entries(rollup.environments)) {
    const status = deriveEnvironmentStatus(env);
    env.status = status;
    rollup.statusPage[environment] = {
      publicStatus: status,
      publicComponents: env.publication?.allowlist ?? [],
      contentHash: env.publication?.contentHash ?? null,
    };
  }

  return rollup;
}

export function rollbackRollupMutation(event) {
  if (event?.type !== "statuspage.Published") {
    throw new Error("only statuspage.Published has a status-page rollback mutation");
  }

  return {
    id: `revert-${event.id}`,
    seq: event.seq + 1,
    type: "statuspage.Unpublished",
    reverts: event.id,
    data: {
      project: event.data.project,
      environment: event.data.environment,
    },
  };
}

function ensureEnvironment(rollup, project, environment) {
  if (!project) {
    throw new Error("reliability event requires data.project");
  }
  if (!environment) {
    throw new Error("reliability event requires data.environment");
  }

  rollup.environments[environment] ??= {
    project,
    environment,
    status: "unknown",
    targets: {},
    incidents: [],
    publication: null,
    restoreDrill: null,
  };

  if (rollup.environments[environment].project !== project) {
    throw new Error(`environment ${environment} mixed projects in one rollup`);
  }

  return rollup.environments[environment];
}

function deriveEnvironmentStatus(environment) {
  if (environment.incidents.length > 0) {
    return "degraded";
  }

  const targets = Object.values(environment.targets);
  if (targets.some((target) => target.fresh === false)) {
    return "delayed/unknown";
  }

  return "operational";
}

function assertEvent(event) {
  if (!event || !isJsonObject(event)) {
    throw new Error("event must be an object");
  }
  if (!event.id) {
    throw new Error("event.id is required");
  }
  if (!Number.isInteger(event.seq)) {
    throw new Error(`event ${event.id} requires integer seq`);
  }
  if (!event.type) {
    throw new Error(`event ${event.id} requires type`);
  }
  if (!event.data || !isJsonObject(event.data)) {
    throw new Error(`event ${event.id} requires data`);
  }
}

function assertFiniteNumber(value, field) {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
}
