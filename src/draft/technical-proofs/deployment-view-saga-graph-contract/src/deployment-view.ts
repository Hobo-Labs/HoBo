import { isJsonString, isJsonObject } from "./json.js";
export const DEPLOYMENT_VIEW_CONTRACT_VERSION = "hobo.deployment-view/v1";

const TERMINAL_STATUSES = new Set(["deployed", "rolled-back"]);

export class DeploymentViewError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeploymentViewError";
  }
}

export function createDeploymentViewProjection(seedEvents = []) {
  const events = normalizeEvents(seedEvents);

  return Object.freeze({
    headSeq: events.at(-1)?.seq ?? 0,

    inspectRun(correlationId, options = {}) {
      const id = requireNonEmptyString(correlationId, "correlationId");
      assertEnvelopeLinkage(events);

      const atSeq = normalizeAtSeq(options.atSeq, this.headSeq);
      const scoped = events.filter((event) => event.seq <= atSeq && event.correlationId === id);
      if (scoped.length === 0) {
        throw new DeploymentViewError(`Unknown deployment run "${id}". No DeploymentView events exist.`);
      }

      return deepFreeze(materializeDeploymentView({ correlationId: id, events: scoped, atSeq }));
    },
  });
}

export function createInspectRunQuery({ eventStore, providerClient: _providerClient } = {}) {
  if (!eventStore || !(eventStore.readByCorrelationId instanceof Function)) {
    throw new TypeError("eventStore.readByCorrelationId must be a function");
  }

  return Object.freeze({
    inspectRun(correlationId, options = {}) {
      const events = eventStore.readByCorrelationId(correlationId, options);
      return createDeploymentViewProjection(events).inspectRun(correlationId, options);
    },
  });
}

function materializeDeploymentView({ correlationId, events, atSeq }) {
  const resources = new Map();
  const execResourceIds = new Map();
  const timeline = [];
  let deploymentId = correlationId;
  let status = "in-flight";
  let partial = true;
  let rollbackReason;
  let rollbackEventId;

  for (const event of events) {
    timeline.push(toTimelineEntry(event));

    switch (event.type) {
      case "deployment.Planned": {
        deploymentId = event.data.deploymentId ?? deploymentId;
        for (const [index, node] of (event.data.plan?.nodes ?? []).entries()) {
          const resource = ensureResource(resources, requireNonEmptyString(node.id, "plan.nodes[].id"), event);
          resource.order = Math.min(resource.order, index);
          resource.deps = normalizeStringArray(node.deps ?? []);
          resource.state = resource.state === "unknown" ? "planned" : resource.state;
        }
        break;
      }
      case "match.Decided": {
        const resource = ensureResource(resources, event.data.resourceId, event);
        resource.match = normalizeMatchDecision(event.data);
        break;
      }
      case "resource.Pending": {
        const resource = ensureResource(resources, event.data.resourceId, event);
        resource.state = "pending";
        resource.deps = normalizeStringArray(event.data.deps ?? resource.deps);
        break;
      }
      case "resource.Provisioning": {
        const resource = ensureResource(resources, event.data.resourceId, event);
        resource.state = "provisioning";
        resource.provider = event.data.provider;
        resource.driver = event.data.driver;
        break;
      }
      case "exec.Started": {
        const resource = ensureResource(resources, event.data.resourceId, event);
        execResourceIds.set(event.data.execId, resource.id);
        resource.execs.push({
          id: event.data.execId,
          status: "started",
          programHash: event.data.programHash,
          firstSeq: event.seq,
          lastSeq: event.seq,
        });
        break;
      }
      case "exec.Output": {
        const resource = resourceForExec(resources, execResourceIds, event.data.execId);
        const exec = ensureExec(resource, event.data.execId, event);
        exec.output ??= [];
        exec.output.push({ stream: event.data.stream, line: event.data.line, seq: event.seq });
        exec.lastSeq = event.seq;
        break;
      }
      case "exec.Succeeded": {
        const resource = resourceForExec(resources, execResourceIds, event.data.execId);
        const exec = ensureExec(resource, event.data.execId, event);
        exec.status = "succeeded";
        exec.outputsHash = event.data.outputsHash;
        exec.lastSeq = event.seq;
        break;
      }
      case "exec.Failed": {
        const resource = resourceForExec(resources, execResourceIds, event.data.execId);
        const exec = ensureExec(resource, event.data.execId, event);
        exec.status = "failed";
        exec.reason = event.data.reason;
        exec.lastSeq = event.seq;
        break;
      }
      case "resource.Provisioned": {
        const resource = ensureResource(resources, event.data.resourceId, event);
        resource.state = "provisioned";
        resource.outputs = clone(event.data.outputs ?? {});
        break;
      }
      case "resource.Failed": {
        const resource = ensureResource(resources, event.data.resourceId, event);
        resource.state = "failed";
        resource.failureReason = event.data.reason;
        break;
      }
      case "deployment.RolledBack": {
        deploymentId = event.data.deploymentId ?? deploymentId;
        status = "rolled-back";
        partial = false;
        rollbackReason = event.data.reason;
        rollbackEventId = event.id;
        break;
      }
      case "resource.Destroying": {
        const resource = ensureResource(resources, event.data.resourceId, event);
        resource.state = "destroying";
        resource.rollback = {
          resourceId: resource.id,
          state: "destroying",
          reason: event.data.reason ?? rollbackReason,
          causedBy: event.causationId ?? rollbackEventId,
        };
        break;
      }
      case "resource.Destroyed": {
        const resource = ensureResource(resources, event.data.resourceId, event);
        resource.state = "destroyed";
        resource.finalStateHash = event.data.finalStateHash;
        resource.rollback = {
          resourceId: resource.id,
          state: "destroyed",
          reason: resource.rollback?.reason ?? rollbackReason,
          causedBy: resource.rollback?.causedBy ?? event.causationId ?? rollbackEventId,
        };
        break;
      }
      case "deployment.Deployed": {
        deploymentId = event.data.deploymentId ?? deploymentId;
        status = "deployed";
        partial = false;
        break;
      }
      default:
        break;
    }
  }

  const nodes = [...resources.values()]
    .sort(compareResources)
    .map(toNode);
  const edges = nodes.flatMap((node) =>
    node.deps.map((dep) => ({ from: dep, to: node.id, kind: "depends-on" })),
  );
  const rollback = nodes
    .filter((node) => node.rollback)
    .map((node) => node.rollback)
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId));

  return {
    contract: DEPLOYMENT_VIEW_CONTRACT_VERSION,
    id: deploymentId,
    correlationId,
    status: TERMINAL_STATUSES.has(status) ? status : "in-flight",
    partial,
    atSeq,
    headSeq: events.at(-1)?.seq ?? 0,
    graph: {
      nodes,
      edges,
      rollback,
    },
    timeline,
  };
}

function ensureResource(resources, resourceId, event) {
  const id = requireNonEmptyString(resourceId, "resourceId");
  if (!resources.has(id)) {
    resources.set(id, {
      id,
      state: "unknown",
      deps: [],
      provider: undefined,
      driver: undefined,
      match: undefined,
      outputs: undefined,
      failureReason: undefined,
      finalStateHash: undefined,
      execs: [],
      rollback: undefined,
      order: Number.MAX_SAFE_INTEGER,
      firstSeq: event.seq,
      lastSeq: event.seq,
    });
  }

  const resource = resources.get(id);
  resource.firstSeq = Math.min(resource.firstSeq, event.seq);
  resource.lastSeq = Math.max(resource.lastSeq, event.seq);
  return resource;
}

function ensureExec(resource, execId, event) {
  if (!resource) {
    throw new DeploymentViewError(`Unknown exec "${execId}" has no resource owner.`);
  }
  const id = requireNonEmptyString(execId, "execId");
  let exec = resource.execs.find((candidate) => candidate.id === id);
  if (!exec) {
    exec = {
      id,
      status: "observed",
      firstSeq: event.seq,
      lastSeq: event.seq,
    };
    resource.execs.push(exec);
  }
  return exec;
}

function resourceForExec(resources, execResourceIds, execId) {
  const resourceId = execResourceIds.get(execId);
  return resourceId ? resources.get(resourceId) : undefined;
}

function normalizeMatchDecision(data) {
  const ranking = clone(data.ranking ?? []);
  const winningRank = ranking.find((entry) => entry.definitionId === data.winner) ?? ranking[0] ?? {};
  return {
    resourceId: data.resourceId,
    winner: data.winner,
    objective: data.objective,
    tie: data.tie,
    rationale: winningRank.rationale,
    ranking,
    rejectedCandidates: clone(data.rejectedCandidates ?? []),
    catalogContentHash: data.catalogContentHash,
  };
}

function toNode(resource) {
  return {
    id: resource.id,
    state: resource.state,
    deps: [...resource.deps],
    provider: resource.provider,
    driver: resource.driver,
    match: clone(resource.match),
    outputs: clone(resource.outputs),
    failureReason: resource.failureReason,
    finalStateHash: resource.finalStateHash,
    execs: resource.execs.map((exec) => clone(exec)),
    rollback: clone(resource.rollback),
    firstSeq: resource.firstSeq,
    lastSeq: resource.lastSeq,
  };
}

function toTimelineEntry(event) {
  return {
    id: event.id,
    seq: event.seq,
    type: event.type,
    time: event.time,
    correlationId: event.correlationId,
    causationId: event.causationId,
    resourceId: event.data.resourceId,
    deploymentId: event.data.deploymentId,
  };
}

function normalizeEvents(seedEvents) {
  if (!Array.isArray(seedEvents)) {
    throw new TypeError("seedEvents must be an array");
  }

  return seedEvents
    .map((event, index) => ({
      ...event,
      id: requireNonEmptyString(event?.id, "event.id"),
      seq: normalizeSeq(event?.seq, "event.seq"),
      type: requireNonEmptyString(event?.type, "event.type"),
      data: clone(event?.data ?? {}),
      index,
    }))
    .sort((left, right) => left.seq - right.seq || left.index - right.index);
}

function assertEnvelopeLinkage(events) {
  for (const event of events) {
    if (!isJsonString(event.correlationId) || event.correlationId.length === 0) {
      throw new DeploymentViewError(`Event ${event.id} is missing correlationId.`);
    }
    if (!isJsonString(event.causationId) || event.causationId.length === 0) {
      throw new DeploymentViewError(`Event ${event.id} is missing causationId.`);
    }
  }
}

function normalizeAtSeq(atSeq, headSeq) {
  if (atSeq === undefined || atSeq === null) {
    return headSeq;
  }
  const seq = normalizeSeq(atSeq, "atSeq");
  if (seq > headSeq) {
    throw new DeploymentViewError(`Cannot inspect at seq ${seq} beyond log head ${headSeq}.`);
  }
  return seq;
}

function normalizeSeq(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("expected an array of strings");
  }
  return value.map((entry) => requireNonEmptyString(entry, "array entry"));
}

function requireNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function compareResources(left, right) {
  return left.order - right.order || left.firstSeq - right.firstSeq || left.id.localeCompare(right.id);
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
