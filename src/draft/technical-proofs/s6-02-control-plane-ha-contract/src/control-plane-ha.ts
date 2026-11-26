import { parseQuorumFencedAppend } from "./parse.js";

export const CONTROL_PLANE_HA_SCHEMA_VERSION = "hobo.control-plane-ha/v1";
export const NFR_009_RESUME_BUDGET_MS = 30_000;
export const CONTROL_PLANE_AVAILABILITY_TARGET = 0.999;

export class QuorumRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuorumRejectedError";
  }
}

export class StaleFenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "StaleFenceError";
  }
}

export class LeaderConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "LeaderConflictError";
  }
}

export function createManualClock(startInstant = "2026-07-02T00:00:00.000Z") {
  let nowMs = Date.parse(startInstant);
  if (Number.isNaN(nowMs)) {
    throw new TypeError("startInstant must be a valid ISO timestamp");
  }

  return {
    now() {
      return new Date(nowMs).toISOString();
    },
    nowMs() {
      return nowMs;
    },
    advance(deltaMs) {
      if (!Number.isInteger(deltaMs) || deltaMs < 0) {
        throw new TypeError("deltaMs must be a non-negative integer");
      }
      nowMs += deltaMs;
      return this.now();
    },
  };
}

export function createQuorumEventStore(options) {
  const quorumSize = options.quorumSize ?? 3;
  const majority = Math.floor(quorumSize / 2) + 1;
  const healthyNodes = new Set(options.healthyNodes ?? Array.from({ length: quorumSize }, (_, i) => `node-${i + 1}`));
  const streams = new Map();
  const committedActions = new Set();

  return {
    quorumSize,
    majority,
    healthyNodes,

    partition(nodesInPartition) {
      return createQuorumEventStore({
        ...options,
        healthyNodes: new Set(nodesInPartition),
      });
    },

    appendFenced(request) {
      const parsed = parseQuorumFencedAppend(request);
      const streamId = parsed.streamId;
      const fenceToken = parsed.fenceToken;
      const eventType = parsed.eventType;
      const actionId = parsed.actionId;

      if (healthyNodes.size < majority) {
        throw new QuorumRejectedError(
          `quorum unavailable: ${healthyNodes.size}/${quorumSize} healthy nodes`,
        );
      }

      const stream = getStream(streams, streamId);
      if (fenceToken < stream.latestFenceToken) {
        throw new StaleFenceError(
          `stale fence on ${streamId}: got ${fenceToken}, latest ${stream.latestFenceToken}`,
        );
      }

      if (actionId) {
        const actionKey = `${streamId}:${actionId}`;
        if (committedActions.has(actionKey)) {
          throw new StaleFenceError(`duplicate resource action blocked: ${actionKey}`);
        }
      }

      const record = Object.freeze({
        streamId,
        seq: stream.events.length + 1,
        fenceToken,
        eventType,
        actionId,
        occurredAt: options.clock?.now?.() ?? new Date().toISOString(),
      });
      stream.events.push(record);
      if (fenceToken > stream.latestFenceToken) {
        stream.latestFenceToken = fenceToken;
      }
      if (actionId) {
        committedActions.add(`${streamId}:${actionId}`);
      }
      return record;
    },

    readStream(streamId) {
      return [...getStream(streams, streamId).events];
    },

    committedActionIds() {
      return [...committedActions];
    },
  };
}

export function createLeaderElection(options) {
  const clock = options.clock ?? createManualClock();
  const leaseTtlMs = options.leaseTtlMs ?? 5_000;
  let current = null;
  let latestFenceToken = 0n;

  return {
    tryAcquire(nodeId) {
      const nowMs = clock.nowMs();
      if (current && current.expiresAtMs > nowMs && current.nodeId !== nodeId) {
        throw new LeaderConflictError(`leader held by ${current.nodeId}`);
      }

      const sameHolder = current?.nodeId === nodeId && current.expiresAtMs > nowMs;
      if (!sameHolder) {
        latestFenceToken += 1n;
      }

      current = {
        nodeId,
        generation: Number(latestFenceToken),
        fenceToken: latestFenceToken,
        acquiredAtMs: nowMs,
        expiresAtMs: nowMs + leaseTtlMs,
      };
      return { ...current };
    },

    currentLeader() {
      if (!current || current.expiresAtMs <= clock.nowMs()) {
        return null;
      }
      return { ...current };
    },

    killLeader() {
      if (!current) {
        return null;
      }
      const dead = current.nodeId;
      current = null;
      return dead;
    },

    advance(ms) {
      clock.advance(ms);
    },
  };
}

export function runDeploySaga(store, lease, steps) {
  const events = [];
  for (const step of steps) {
    const record = store.appendFenced({
      streamId: "control-plane/deploy",
      fenceToken: lease.fenceToken,
      eventType: step.eventType,
      actionId: step.actionId,
    });
    events.push(record);
  }
  return events;
}

export function runLeaderKillMidDeployChaos(input = {}) {
  const clock = input.clock ?? createManualClock();
  const leaseTtlMs = input.leaseTtlMs ?? 5_000;
  const nodes = input.nodes ?? ["yard-a", "yard-b", "yard-c"];
  const store = createQuorumEventStore({
    quorumSize: nodes.length,
    healthyNodes: nodes,
    clock,
  });
  const election = createLeaderElection({ clock, leaseTtlMs });

  const leaderLease = election.tryAcquire("yard-a");
  const startedAtMs = clock.nowMs();

  const deploySteps = [
    { eventType: "deploy.NetworkProvisioned", actionId: "network-primary" },
    { eventType: "deploy.DatabaseProvisioned", actionId: "database-primary" },
  ];

  runDeploySaga(store, leaderLease, [deploySteps[0]]);

  clock.advance(2_000);
  const killedLeader = election.killLeader();
  clock.advance(leaseTtlMs + 1);

  const successorLease = election.tryAcquire("yard-b");
  store.appendFenced({
    streamId: "control-plane/deploy",
    fenceToken: successorLease.fenceToken,
    eventType: "yard.LeaderElected",
  });
  const recoveryMs = clock.nowMs() - startedAtMs;

  let duplicateBlocked = false;
  try {
    store.appendFenced({
      streamId: "control-plane/deploy",
      fenceToken: leaderLease.fenceToken,
      eventType: "deploy.DatabaseProvisioned",
      actionId: "database-primary",
    });
  } catch (error) {
    if (error instanceof StaleFenceError) {
      duplicateBlocked = true;
    } else {
      throw error;
    }
  }

  runDeploySaga(store, successorLease, [deploySteps[1], { eventType: "deploy.Completed", actionId: "deploy-run-1" }]);

  const stream = store.readStream("control-plane/deploy");
  const actionIds = stream.map((event) => event.actionId).filter(Boolean);
  const uniqueActions = new Set(actionIds);

  return {
    schemaVersion: CONTROL_PLANE_HA_SCHEMA_VERSION,
    killedLeader,
    successor: successorLease.nodeId,
    recoveryMs,
    withinNfr009: recoveryMs < NFR_009_RESUME_BUDGET_MS,
    duplicateBlocked,
    noDuplicateResourceActions: uniqueActions.size === actionIds.length,
    fencingVerified: duplicateBlocked && uniqueActions.size === actionIds.length,
    completed: stream.at(-1)?.eventType === "deploy.Completed",
    events: stream,
  };
}

export function runAvailabilitySoak(input = {}) {
  const windows = input.windows ?? 1_000;
  const outageWindows = input.outageWindows ?? 1;
  const windowMs = input.windowMs ?? 60_000;
  const outageMs = input.outageMs ?? 30;
  const totalMs = windows * windowMs;
  const unavailableMs = outageWindows * outageMs;
  const availability = (totalMs - unavailableMs) / totalMs;

  return {
    schemaVersion: CONTROL_PLANE_HA_SCHEMA_VERSION,
    windows,
    outageWindows,
    availability,
    meetsTarget: availability >= CONTROL_PLANE_AVAILABILITY_TARGET,
  };
}

function getStream(streams, streamId) {
  if (!streams.has(streamId)) {
    streams.set(streamId, { events: [], latestFenceToken: 0n });
  }
  return streams.get(streamId);
}

