export const PROJECTION_LAGGED_EVENT_TYPE = "projection.Lagged";

const CHANGE_FEED_SOURCE = "change-feed-sink-cache";

export function createProjectionLagHarness({
  projection,
  ownerCamp,
  readerCamp,
  lagBoundMs = projection.consistency?.boundMs ?? 0,
  emitLagEvents = true,
}) {
  const ownerEvents = [];
  const emittedEvents = [];
  const readAudit = [];
  let sinkThroughSeq = 0;
  let lagEventSeq = 0;
  let lagActive = false;
  let lastObservedLagMs = 0;

  function appendOwnerEvents(events) {
    ownerEvents.push(...events);
    ownerEvents.sort((left, right) => left.seq - right.seq);
  }

  function replicateChangeFeed({ throughSeq }) {
    sinkThroughSeq = Math.max(sinkThroughSeq, throughSeq);
  }

  function readProjection({
    source,
    tenant,
    consistency,
    sessionSeq,
    nowMs = latestOwnerTime(),
  }) {
    if (source === "native-log") {
      return readNativeLog({ tenant, consistency, sessionSeq });
    }

    if (source !== "change-feed-sink") {
      throw new Error(`Unknown projection source: ${source}`);
    }

    return readChangeFeedSink({ tenant, consistency, nowMs });
  }

  function readNativeLog({ tenant, consistency, sessionSeq }) {
    const visibleEvents =
      sessionSeq === undefined
        ? ownerEvents
        : ownerEvents.filter((event) => event.seq <= sessionSeq);
    const rows = materialize(visibleEvents, tenant);
    const freshnessClaim =
      consistency === "session" ? "read-your-writes" : "fresh";
    const result = {
      source: "native-log",
      readClass: consistency,
      consistency,
      freshnessClaim,
      rows,
      labels: [consistency, "native-log"],
      staleness: {
        status: "fresh",
      },
    };

    readAudit.push({
      query: `${projection.name} via native-log`,
      source: "native-log",
      readClass: consistency,
      consistency,
      freshness: freshnessClaim,
      severity: "info",
    });

    return result;
  }

  function readChangeFeedSink({ tenant, consistency, nowMs }) {
    const observedLagMs = observeLag();
    const readClass =
      consistency === "eventual" ? "eventual" : "bounded-staleness";
    const lagStatus =
      observedLagMs > lagBoundMs ? "exceeds-bound" : "within-bound";

    reconcileLag({ tenant, consistency: readClass, observedLagMs, nowMs });

    const rows = materialize(
      ownerEvents.filter((event) => event.seq <= sinkThroughSeq),
      tenant,
    );

    if (consistency === "eventual") {
      const result = {
        source: CHANGE_FEED_SOURCE,
        readClass,
        consistency,
        freshnessClaim: "eventual-stale-ok",
        rows,
        labels: ["eventual"],
        staleness: {
          status: "stale-ok",
          observedLagMs,
        },
      };

      readAudit.push({
        query: `${projection.name} via ${CHANGE_FEED_SOURCE}`,
        source: CHANGE_FEED_SOURCE,
        readClass,
        consistency,
        freshness: "stale-ok",
        severity: "info",
      });

      return result;
    }

    const result = {
      source: CHANGE_FEED_SOURCE,
      readClass,
      consistency,
      freshnessClaim: "bounded-staleness",
      rows,
      labels:
        lagStatus === "exceeds-bound"
          ? ["bounded-staleness", "projection-lagged"]
          : ["bounded-staleness"],
      staleness: {
        status: lagStatus,
        declaredBoundMs: lagBoundMs,
        observedLagMs,
      },
    };

    readAudit.push({
      query: `${projection.name} via ${CHANGE_FEED_SOURCE}`,
      source: CHANGE_FEED_SOURCE,
      readClass,
      consistency,
      lagStatus,
      severity: lagStatus === "exceeds-bound" ? "warning" : "info",
    });

    return result;
  }

  function materialize(events, tenant) {
    const rows = new Map();

    for (const event of events) {
      if (event.data?.tenant !== tenant) {
        continue;
      }

      const handler = projection.on[event.type];
      if (!handler) {
        continue;
      }

      const key = projection.key(event);
      const current = rows.get(key) ?? projection.initialState();
      rows.set(key, {
        ...handler(current, event),
        key,
        tenant,
      });
    }

    return [...rows.values()];
  }

  function reconcileLag({ tenant, consistency, observedLagMs, nowMs }) {
    lastObservedLagMs = observedLagMs;

    if (observedLagMs > lagBoundMs) {
      if (!lagActive && emitLagEvents) {
        emitLagEvent({
          tenant,
          consistency,
          observedLagMs,
          nowMs,
          status: "lagged",
        });
      }
      lagActive = true;
      return;
    }

    if (lagActive && emitLagEvents) {
      emitLagEvent({
        tenant,
        consistency,
        observedLagMs,
        nowMs,
        status: "cleared",
      });
    }
    lagActive = false;
  }

  function emitLagEvent({ tenant, consistency, observedLagMs, nowMs, status }) {
    emittedEvents.push({
      type: PROJECTION_LAGGED_EVENT_TYPE,
      streamId: `projection/${projection.name}/lag/${ownerCamp}/${projection.sink.id}`,
      seq: ++lagEventSeq,
      occurredAtMs: nowMs,
      data: {
        projection: projection.name,
        source: CHANGE_FEED_SOURCE,
        ownerCamp,
        readerCamp,
        sink: projection.sink.id,
        tenant,
        declaredBoundMs: lagBoundMs,
        observedLagMs,
        consistency,
        status,
      },
    });
  }

  function observeLag() {
    if (ownerEvents.length === 0) {
      return 0;
    }

    const latestOwner = ownerEvents.at(-1);
    const sinkWatermark = [...ownerEvents]
      .reverse()
      .find((event) => event.seq <= sinkThroughSeq);
    const sinkOccurredAtMs = sinkWatermark?.occurredAtMs ?? 0;

    return Math.max(0, latestOwner.occurredAtMs - sinkOccurredAtMs);
  }

  function latestOwnerTime() {
    return ownerEvents.at(-1)?.occurredAtMs ?? 0;
  }

  function events() {
    return emittedEvents.map((event) => ({
      ...event,
      data: { ...event.data },
    }));
  }

  function lagState() {
    return {
      active: lagActive,
      declaredBoundMs: lagBoundMs,
      observedLagMs: observeLag(),
    };
  }

  function doctor() {
    return readAudit.map((entry) => ({ ...entry }));
  }

  function auditLagSignals() {
    const observedLagMs = lastObservedLagMs || observeLag();
    const hasLagSignal = emittedEvents.some(
      (event) =>
        event.type === PROJECTION_LAGGED_EVENT_TYPE &&
        event.data.status === "lagged",
    );

    if (observedLagMs <= lagBoundMs || hasLagSignal) {
      return [];
    }

    return [
      {
        projection: projection.name,
        sink: projection.sink.id,
        severity: "error",
        reason: "lag-over-bound-without-projection.Lagged",
        declaredBoundMs: lagBoundMs,
        observedLagMs,
      },
    ];
  }

  return {
    appendOwnerEvents,
    replicateChangeFeed,
    readProjection,
    events,
    lagState,
    doctor,
    auditLagSignals,
  };
}

export function evaluateConsistencyDeclaration({
  entity,
  declaredConsistency,
  topology,
  source,
}) {
  if (
    declaredConsistency === "strong" &&
    topology === "cross-camp" &&
    source !== "native-log"
  ) {
    return {
      ok: false,
      entity,
      declaredConsistency,
      topology,
      source,
      effectiveConsistency: null,
      action: "flag",
      reason: "strong-cross-camp-unavailable",
      message: `${entity} declares strong cross-Camp reads, but ${source} can only prove bounded-staleness.`,
    };
  }

  return {
    ok: true,
    entity,
    declaredConsistency,
    topology,
    source,
    effectiveConsistency: declaredConsistency,
    action: "allow",
  };
}
