import { assertReplayEqualsLive } from "../../replay-live-equivalence-poc/src/equivalence.js";
import { isJsonString, isJsonObject } from "./json.js";


const DEPLOY_STREAM_PREFIX = "deployment:";

export function createMockPostgresEventStore() {
  const streams = new Map();

  return {
    runtime: "@hobo/runtime-postgres-mock",
    append(streamId, event, { expectedSeq = 0 } = {}) {
      const stream = streams.get(streamId) ?? [];
      if (stream.length !== expectedSeq) {
        const error = new Error("event store optimistic concurrency conflict");
        error.code = "eventstore-seq-conflict";
        throw error;
      }
      const seq = stream.length + 1;
      const stored = freeze({
        ...event,
        streamId,
        seq,
      });
      stream.push(stored);
      streams.set(streamId, stream);
      return stored;
    },
    read(streamId) {
      return clone(streams.get(streamId) ?? []);
    },
    readAll() {
      return [...streams.entries()]
        .flatMap(([, events]) => events)
        .sort((left, right) => left.streamId.localeCompare(right.streamId) || left.seq - right.seq);
    },
  };
}

export function createGateway({ eventStore, authorize = defaultAuthorize }) {
  return {
    eventStore,
    projectionHost: null,
    authorize,

    handleRest(request) {
      const path = requiredString(request.path, "path");
      if (request.method === "POST" && path === "/v1/commands/deploy") {
        return submitDeployCommand({
          gateway: this,
          authorization: request.headers?.Authorization ?? request.headers?.authorization,
          body: request.body ?? {},
        });
      }
      if (request.method === "GET" && path === "/v1/read-models/deployment-timeline") {
        return {
          status: 200,
          body: this.projectionHost.readTimeline({
            deploymentId: request.query?.deploymentId,
          }),
        };
      }
      return { status: 404, body: { error: "not-found" } };
    },

    handleRpc(request) {
      if (request.method !== "Deploy") {
        return { status: 404, body: { error: "unknown-rpc-method" } };
      }
      return submitDeployCommand({
        gateway: this,
        authorization: request.authorization,
        body: request.params ?? {},
      });
    },
  };
}

export function createProjectionHost({ eventStore }) {
  let liveState = freeze(initialTimelineState());

  return {
    apply(event) {
      liveState = freeze(foldDeploymentTimeline(liveState, event));
      return liveState;
    },
    readTimeline({ deploymentId } = {}) {
      const timeline = deploymentId
        ? liveState.timelines.find((entry) => entry.deploymentId === deploymentId)
        : liveState.timelines.find((entry) => entry.deploymentId !== "yard-bootstrap");
      if (!timeline) {
        return {
          correlationComplete: false,
          graphNodes: [],
          missingEvents: ["deployment.DeployRequested"],
          replayEquivalent: true,
        };
      }
      return {
        correlationComplete: timeline.correlationComplete,
        graphNodes: timeline.graphNodes,
        missingEvents: timeline.missingEvents,
        replayEquivalent: timeline.replayEquivalent,
        entries: timeline.entries,
      };
    },
    rebuildFromLog(events) {
      return events.reduce((state, event) => foldDeploymentTimeline(state, event), initialTimelineState());
    },
    liveState() {
      return clone(liveState);
    },
    assertReplayEquivalent(events) {
      return assertReplayEqualsLive({
        events,
        fold: foldDeploymentTimeline,
        initialState: initialTimelineState(),
      });
    },
    eventStore,
  };
}

export function runHoboYardUp(input = {}) {
  const yard = requiredString(input.yard ?? "yard-local", "yard");
  const camp = requiredString(input.camp ?? "camp-prod", "camp");
  const eventStore = input.eventStore ?? createMockPostgresEventStore();
  const projectionHost = input.projectionHost ?? createProjectionHost({ eventStore });
  const gateway = createGateway({ eventStore, authorize: input.authorize });
  gateway.projectionHost = projectionHost;

  const bootEvents = [];
  if (!input.skipBootEvents) {
    bootEvents.push(
      eventStore.append("yard:control-plane", {
        id: `${yard}:boot:1`,
        type: "yard.Started",
        occurredAt: input.now ?? new Date(0).toISOString(),
        data: { yard, camp, runtime: eventStore.runtime },
      }),
    );
    projectionHost.apply(bootEvents[0]);
  }

  return freeze({
    status: "running",
    yard,
    camp,
    runtime: eventStore.runtime,
    gateway,
    eventStore,
    projectionHost,
    bootEvents: clone(bootEvents),
  });
}

export function submitDeployCommand({ gateway, authorization, body }) {
  const auth = authenticate(authorization);
  if (!auth.ok) {
    return { status: auth.status, body: { accepted: false, reason: auth.reason } };
  }

  const command = parseDeployCommand(body);
  const decision = gateway.authorize(auth.principal, command);
  if (!decision.allowed) {
    return { status: 403, body: { accepted: false, reason: decision.reason } };
  }

  const streamId = `${DEPLOY_STREAM_PREFIX}${command.deploymentKey}`;
  const expectedSeq = gateway.eventStore.read(streamId).length;
  const event = gateway.eventStore.append(
    streamId,
    {
      id: `${command.deploymentId}:deploy-requested`,
      type: "deployment.DeployRequested",
      occurredAt: command.occurredAt,
      correlationId: command.deploymentId,
      data: {
        deploymentId: command.deploymentId,
        bindleRef: command.bindleRef,
        camp: command.camp,
        yard: command.yard,
        principal: auth.principal.id,
        scope: auth.principal.scope,
      },
    },
    { expectedSeq },
  );

  gateway.projectionHost.apply(event);

  return {
    status: 202,
    body: {
      accepted: true,
      eventType: event.type,
      seq: event.seq,
      streamId: event.streamId,
      correlationId: event.correlationId,
    },
  };
}

export function foldDeploymentTimeline(state, event) {
  if (!event) {
    return state;
  }

  const timelines = new Map(state.timelines.map((timeline) => [timeline.deploymentId, clone(timeline)]));

  if (String(event.type).startsWith("deployment.")) {
    const deploymentId = requiredString(event.data?.deploymentId ?? event.correlationId, "deploymentId");
    const timeline = timelines.get(deploymentId) ?? {
      deploymentId,
      entries: [],
      graphNodes: [],
      missingEvents: [],
      correlationComplete: false,
      replayEquivalent: true,
    };

    if (event.type === "deployment.DeployRequested") {
      timeline.entries.push({
        deploymentId,
        phase: "DeployRequested",
        occurredAt: event.occurredAt,
        seq: event.seq,
      });
      timeline.graphNodes = unique([...timeline.graphNodes, "DeployRequested"]);
    }

    if (event.type === "deployment.Planned") {
      timeline.entries.push({
        deploymentId,
        phase: "Planned",
        occurredAt: event.occurredAt,
        seq: event.seq,
      });
      timeline.graphNodes = unique([...timeline.graphNodes, "Planned"]);
    }

    if (event.type === "deployment.Deployed") {
      timeline.entries.push({
        deploymentId,
        phase: "Deployed",
        occurredAt: event.occurredAt,
        seq: event.seq,
      });
      timeline.graphNodes = unique([...timeline.graphNodes, "Deployed"]);
      timeline.correlationComplete = true;
    }

    timelines.set(deploymentId, timeline);
  }

  return freeze({
    timelines: [...timelines.values()].map((timeline) =>
      freeze({
        ...timeline,
        entries: freeze([...timeline.entries]),
        graphNodes: freeze([...timeline.graphNodes]),
        missingEvents: freeze([...timeline.missingEvents]),
      }),
    ),
    eventCount: state.eventCount + 1,
  });
}

function initialTimelineState() {
  return { timelines: [], eventCount: 0 };
}

function parseDeployCommand(body) {
  const deploymentId = requiredString(body.deploymentId, "deploymentId");
  const bindleRef = requiredString(body.bindleRef ?? body.bindle_ref, "bindleRef");
  const camp = requiredString(body.camp, "camp");
  const yard = requiredString(body.yard, "yard");
  const deploymentKey = deploymentId.split(":")[1] ?? deploymentId;

  return freeze({
    deploymentId,
    deploymentKey,
    bindleRef,
    camp,
    yard,
    occurredAt: body.occurredAt ?? new Date(0).toISOString(),
  });
}

function authenticate(authorization) {
  if (!authorization || !isJsonString(authorization)) {
    return { ok: false, status: 401, reason: "missing-authorization" };
  }

  const match = /^Bearer\s+yard-svid:(?<subject>[^@]+)@(?<camp>[^\s]+)$/i.exec(authorization);
  if (!match?.groups) {
    return { ok: false, status: 401, reason: "invalid-svid-format" };
  }

  return {
    ok: true,
    principal: freeze({
      id: match.groups.subject,
      camp: match.groups.camp,
      scope: `deploy:${match.groups.camp}`,
    }),
  };
}

function defaultAuthorize(principal, command) {
  if (principal.camp !== command.camp) {
    return { allowed: false, reason: "camp-mismatch" };
  }
  if (!principal.scope.startsWith("deploy:")) {
    return { allowed: false, reason: "insufficient-scope" };
  }
  return { allowed: true };
}

function requiredString(value, fieldName) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new TypeError(`${fieldName} is required`);
  }
  return value.trim();
}

function unique(values) {
  return [...new Set(values)];
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    freeze(child);
  }
  return Object.freeze(value);
}

export { assertReplayEqualsLive };
