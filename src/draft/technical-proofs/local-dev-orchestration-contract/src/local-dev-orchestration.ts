import { isJsonString } from "./json.js";
import { randomUUID } from "node:crypto";

export class LocalDevOrchestrationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "LocalDevOrchestrationError";
    this.code = code;
    this.details = details;
  }
}

export function createLocalDevOrchestrator({
  now = () => new Date().toISOString(),
  idFactory = (prefix) => `${prefix}-${randomUUID()}`,
} = {}) {
  return {
    run({ manifest, eventLog = [], manualStarts = [], jobExitCodes = {}, healthOutcomes = {} }) {
      const graph = buildLocalDevGraph(manifest);
      const state = createReplayState();
      const events = [...eventLog];
      const activationLog = [];
      let nextSeq = maxSeq(events) + 1;
      let wave = 0;

      for (const event of eventLog) {
        applyEvent(state, event);
      }

      const manualStartSet = new Set(manualStarts);

      while (!isConverged(state, graph)) {
        const activations = [...graph.resources.values()].filter((resource) =>
          canActivate(state, resource, graph, manualStartSet),
        );

        if (activations.length === 0) {
          break;
        }

        for (const resource of activations) {
          const currentPhase = state.phase.get(resource.id) ?? "stopped";

          if (currentPhase === "stopped") {
            state.phase.set(resource.id, "starting");
            activationLog.push({
              resourceId: resource.id,
              wave,
              satisfiedDependencies: satisfiedDeps(state, resource),
              gates: resource.gates,
            });
            emit(events, {
              id: idFactory("local-event"),
              type: "local.Starting",
              seq: nextSeq++,
              time: now(),
              sessionId: manifest.sessionId,
              resourceId: resource.id,
              data: { wave, gates: resource.gates },
            });
          }

          if (resource.kind === "job") {
            const exitCode = jobExitCodes[resource.id];
            if (exitCode === undefined) {
              continue;
            }
            if (exitCode !== 0) {
              markFailed(state, resource.id);
              emit(events, {
                id: idFactory("local-event"),
                type: "local.StartFailed",
                seq: nextSeq++,
                time: now(),
                sessionId: manifest.sessionId,
                resourceId: resource.id,
                data: { exitCode },
              });
              continue;
            }
          }

          if (resource.gates.requiresHealth && healthOutcomes[resource.id] !== true) {
            continue;
          }

          markReady(state, resource.id);
          emit(events, {
            id: idFactory("local-event"),
            type: "local.Ready",
            seq: nextSeq++,
            time: now(),
            sessionId: manifest.sessionId,
            resourceId: resource.id,
            data: {
              replicas: resource.gates.localReplicas,
              scalingLabel: resource.gates.scalingLabel,
              residencyLabel: resource.gates.residencyLabel,
              endpointExternal: resource.gates.endpointExternal,
              endpointLabel: resource.gates.endpointExternal ? "external:localhost" : null,
              resolvedEnv: resolveEnv(resource, state),
            },
          });
        }

        wave += 1;
        if (wave > graph.resources.size + 2) {
          break;
        }
      }

      return {
        events,
        activationLog,
        state: snapshotState(state, graph),
        shutdownOrder: reverseDependencyOrder([...graph.resources.values()]).map((resource) => resource.id),
      };
    },
  };
}

export function buildLocalDevGraph(manifest) {
  assertManifest(manifest);

  const resources = new Map();
  for (const raw of manifest.resources ?? []) {
    resources.set(raw.id, normalizeResource(raw));
  }

  for (const resource of resources.values()) {
    for (const dep of [...resource.deps, ...resource.gates.waitFor, ...resource.gates.waitForCompletion]) {
      if (!resources.has(dep)) {
        throw new LocalDevOrchestrationError(
          `Unknown dependency "${dep}" for resource "${resource.id}".`,
          "unknown-dependency",
          { resourceId: resource.id, dependencyId: dep },
        );
      }
    }
  }

  assertAcyclic(resources);
  return { sessionId: manifest.sessionId, resources };
}

export function reverseDependencyOrder(resources) {
  const byId = new Map(resources.map((resource, index) => [resource.id, { resource, index }]));
  const visiting = new Set();
  const visited = new Set();
  const depths = new Map();

  const depth = (resource) => {
    if (depths.has(resource.id)) {
      return depths.get(resource.id);
    }
    if (visiting.has(resource.id)) {
      throw new LocalDevOrchestrationError(
        `Dependency cycle includes ${resource.id}.`,
        "dependency-cycle",
        { resourceId: resource.id },
      );
    }
    visiting.add(resource.id);
    const depIds = [...resource.deps, ...resource.gates.waitFor, ...resource.gates.waitForCompletion];
    const dependencyDepths = depIds
      .filter((depId) => byId.has(depId))
      .map((depId) => depth(byId.get(depId).resource));
    const value = dependencyDepths.length === 0 ? 0 : Math.max(...dependencyDepths) + 1;
    visiting.delete(resource.id);
    visited.add(resource.id);
    depths.set(resource.id, value);
    return value;
  };

  for (const resource of resources) {
    if (!visited.has(resource.id)) {
      depth(resource);
    }
  }

  return [...resources].sort((left, right) => {
    const byDepth = depths.get(right.id) - depths.get(left.id);
    if (byDepth !== 0) {
      return byDepth;
    }
    return byId.get(left.id).index - byId.get(right.id).index;
  });
}

function normalizeResource(raw) {
  const annotations = raw.annotations ?? {};
  const scaling = annotations.scaling ?? null;

  return {
    id: raw.id,
    kind: raw.kind ?? "service",
    deps: [...(raw.deps ?? [])],
    env: { ...raw.env },
    gates: {
      explicitStartup: annotations.explicitStartup === true,
      waitFor: [...(annotations.waitFor ?? [])],
      waitForCompletion: [...(annotations.waitForCompletion ?? [])],
      requiresHealth: annotations.healthCheck === true,
      persistent: annotations.lifetime === "persistent",
      localReplicas: 1,
      scalingLabel: scaling ? "scaling: local-fixed-1" : null,
      residencyLabel: annotations.residency ?? null,
      endpointExternal: annotations.endpointExternal === true,
    },
  };
}

function canActivate(state, resource, graph, manualStartSet) {
  const phase = state.phase.get(resource.id) ?? "stopped";
  if (phase === "ready" || phase === "failed") {
    return false;
  }

  if (!depsReady(state, resource)) {
    return false;
  }

  if (resource.gates.explicitStartup && !manualStartSet.has(resource.id) && phase === "stopped") {
    if (resource.gates.waitFor.length === 0) {
      return false;
    }
  }

  return phase === "stopped" || phase === "starting";
}

function depsReady(state, resource) {
  for (const depId of [...resource.deps, ...resource.gates.waitFor, ...resource.gates.waitForCompletion]) {
    if (state.phase.get(depId) !== "ready") {
      return false;
    }
  }
  return true;
}

function satisfiedDeps(state, resource) {
  return [...resource.deps, ...resource.gates.waitFor, ...resource.gates.waitForCompletion].filter(
    (depId) => state.phase.get(depId) === "ready",
  );
}

function resolveEnv(resource, state) {
  const resolved = {};
  for (const [key, value] of Object.entries(resource.env)) {
    if (!isJsonString(value) || !value.startsWith("{") || !value.endsWith("}")) {
      resolved[key] = value;
      continue;
    }
    const depId = value.slice(1, -1).split(".")[0];
    if (state.phase.get(depId) !== "ready") {
      throw new LocalDevOrchestrationError(
        `Env ref ${value} for ${resource.id} resolved before ${depId} was ready.`,
        "env-ref-premature",
        { resourceId: resource.id, ref: value },
      );
    }
    resolved[key] = `${depId}.ready`;
  }
  return resolved;
}

function createReplayState() {
  return { phase: new Map() };
}

function applyEvent(state, event) {
  if (event.type === "local.Ready") {
    markReady(state, event.resourceId);
  }
  if (event.type === "local.StartFailed") {
    markFailed(state, event.resourceId);
  }
  if (event.type === "local.Starting") {
    state.phase.set(event.resourceId, "starting");
  }
}

function markReady(state, resourceId) {
  state.phase.set(resourceId, "ready");
}

function markFailed(state, resourceId) {
  state.phase.set(resourceId, "failed");
}

function isConverged(state, graph) {
  for (const resourceId of graph.resources.keys()) {
    const phase = state.phase.get(resourceId) ?? "stopped";
    if (phase !== "ready" && phase !== "failed") {
      return false;
    }
  }
  return true;
}

function snapshotState(state, graph) {
  const waiting = [];
  const ready = [];
  const failed = [];

  for (const resourceId of graph.resources.keys()) {
    const phase = state.phase.get(resourceId) ?? "stopped";
    if (phase === "ready") {
      ready.push(resourceId);
    } else if (phase === "failed") {
      failed.push(resourceId);
    } else if (phase !== "starting") {
      waiting.push(resourceId);
    } else {
      waiting.push(resourceId);
    }
  }

  return {
    readyResourceIds: ready.sort(),
    failedResourceIds: failed.sort(),
    waitingResourceIds: waiting.sort(),
    converged: waiting.length === 0,
  };
}

function assertManifest(manifest) {
  if (!manifest?.sessionId) {
    throw new LocalDevOrchestrationError("manifest.sessionId is required.", "missing-session");
  }
}

function assertAcyclic(resources) {
  reverseDependencyOrder([...resources.values()]);
}

function emit(events, event) {
  events.push(event);
}

function maxSeq(events) {
  return events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0);
}
