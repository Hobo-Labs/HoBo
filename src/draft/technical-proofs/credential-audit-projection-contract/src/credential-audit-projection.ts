import { isJsonString, isJsonObject } from "./json.js";
import { createHash } from "node:crypto";
import {

  createIdentityEvent,
  foldCredentialAudit,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import {
  CompactionRejectedError,
  createSnapshotCompactionLog,
  foldCounter,
} from "../../snapshot-compaction-contract/src/snapshot-compaction-contract.js";

export const CREDENTIAL_AUDIT_VIEW = "CredentialAuditView";
export const AUDIT_RETENTION_FLOOR_DAYS = 2555;
export const AUDIT_RETENTION_FLOOR_MS = AUDIT_RETENTION_FLOOR_DAYS * 24 * 60 * 60 * 1000;
export const NEVER_COMPACT_AUDIT_STREAM_PREFIXES = Object.freeze([
  "token.",
  "resource.",
  "policy.",
]);

const IDENTITY_AUDIT_EVENT_PREFIXES = Object.freeze(["identity.", "token."]);

export function isCredentialAuditSourceEvent(event) {
  return (
    isJsonString(event?.type) &&
    IDENTITY_AUDIT_EVENT_PREFIXES.some((prefix) => event.type.startsWith(prefix))
  );
}

export function snapshotCredentialAuditView(events, options = {}) {
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }

  const seq = requireNonNegativeInteger(options.seq, "options.seq");
  const sourceEvents = events
    .filter((event) => isCredentialAuditSourceEvent(event) && eventSeq(event) <= seq)
    .sort(compareEvents);

  for (const event of sourceEvents) {
    const validation = validateIdentityEvent(event);
    if (!validation.ok) {
      throw new Error(validation.errors.join("; "));
    }
  }

  const folded = foldCredentialAudit(sourceEvents);
  const timelines = buildPrincipalTimelines(sourceEvents);
  const payload = {
    view: CREDENTIAL_AUDIT_VIEW,
    seq,
    chains: folded.chains,
    revokedGrantIds: folded.revokedGrantIds,
    anomalies: folded.anomalies,
    timelines,
    grantsById: Object.fromEntries(
      Object.entries(folded.grantsById).map(([grantId, event]) => [
        grantId,
        {
          grantId,
          type: event.type,
          subject: principalKey(event.data.subject),
          target: `${event.data.target.kind}:${event.data.target.id}`,
          audience: event.data.audience,
          scopes: [...event.data.scopes].sort(),
          grantedAt: event.time,
          revoked: folded.revokedGrantIds.includes(grantId),
        },
      ]),
    ),
  };

  return attachSourceEvents(
    {
      ...payload,
      digest: sha256(canonicalJson(payload)),
    },
    sourceEvents,
  );
}

export function applyCredentialAuditEvent(view, event) {
  if (!view || view.view !== CREDENTIAL_AUDIT_VIEW || !Array.isArray(view.__events)) {
    throw new TypeError("view must be a CredentialAuditView snapshot");
  }
  return snapshotCredentialAuditView([...view.__events, event], {
    seq: Math.max(view.seq, eventSeq(event)),
  });
}

export function queryCredentialAuditByPrincipal(view, principalId) {
  assertCredentialAuditView(view);
  const timeline = view.timelines[principalId];
  if (!timeline) {
    return { principalId, entries: [], chains: [] };
  }

  const chains = view.chains.filter(
    (chain) => chain.user === principalId || chain.agent === principalId,
  );

  return {
    principalId,
    entries: timeline.entries,
    chains,
  };
}

export function queryCredentialAuditViaGateway(view, query = {}) {
  assertCredentialAuditView(view);

  if (query.grantId) {
    const grant = view.grantsById[query.grantId];
    if (!grant) {
      return { ok: false, code: "grant.not_found", grantId: query.grantId };
    }
    return { ok: true, surface: "gateway", grant };
  }

  if (query.principalId) {
    return {
      ok: true,
      surface: "gateway",
      audit: queryCredentialAuditByPrincipal(view, query.principalId),
    };
  }

  return {
    ok: true,
    surface: "gateway",
    digest: view.digest,
    seq: view.seq,
    chainCount: view.chains.length,
    anomalyCount: view.anomalies.length,
  };
}

export function queryCredentialAuditViaMcp(view, tool, args = {}) {
  assertCredentialAuditView(view);

  if (tool === "inspect_credential_audit") {
    if (args.runId) {
      const runEvents = view.__events.filter((event) => event.correlationId === `run:${args.runId}:credentials`);
      const folded = foldCredentialAudit(runEvents);
      return {
        ok: true,
        surface: "mcp",
        tool,
        runId: args.runId,
        chains: folded.chains,
        anomalies: folded.anomalies,
      };
    }
    if (args.principalId) {
      return {
        ok: true,
        surface: "mcp",
        tool,
        audit: queryCredentialAuditByPrincipal(view, args.principalId),
      };
    }
    return { ok: false, code: "mcp.missing_argument", tool, required: ["runId", "principalId"] };
  }

  if (tool === "list_credential_trails") {
    return {
      ok: true,
      surface: "mcp",
      tool,
      trails: view.chains.map((chain) => ({
        user: chain.user,
        agent: chain.agent,
        target: chain.target,
        grantId: chain.grants[0],
        revoked: chain.revoked,
      })),
    };
  }

  return { ok: false, code: "mcp.unknown_tool", tool };
}

export function assertAuditStreamsNeverCompacted(streamIds) {
  const log = createSnapshotCompactionLog();
  const failures = [];

  for (const streamId of streamIds) {
    log.append({ streamId, type: "token.Granted", data: { grantId: "probe" }, seq: 1 });
    try {
      log.compactDomainStream(streamId, {
        fold: foldCounter,
        retentionFloorSeq: 1,
        throughSeq: 1,
      });
      failures.push({ streamId, error: "compaction unexpectedly succeeded" });
    } catch (error) {
      if (!(error instanceof CompactionRejectedError)) {
        failures.push({ streamId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

export function assertRetentionFloorPreservesAuditEvents(streamId, events, options = {}) {
  const now = options.now ?? Date.now();
  const floorMs = options.floorMs ?? AUDIT_RETENTION_FLOOR_MS;
  const log = createSnapshotCompactionLog();

  for (const event of events) {
    const timestamp = event.timestamp ?? now - floorMs - 86_400_000;
    log.append({
      streamId,
      type: event.type,
      data: event.data ,
      seq: event.seq,
      timestamp,
    });
  }

  const throughSeq = Math.max(...events.map((event) => event.seq));
  let compactionRejected = false;
  try {
    log.compactDomainStream(streamId, {
      fold: foldCounter,
      retentionFloorSeq: 1,
      throughSeq,
    });
  } catch (error) {
    compactionRejected = error instanceof CompactionRejectedError;
  }

  const oldest = Math.min(...log.activeEvents(streamId).map((event) => event.timestamp ?? now));
  const retained = log.activeEvents(streamId);
  const olderThanFloor = retained.filter((event) => now - (event.timestamp ?? now) > floorMs);

  return {
    ok:
      compactionRejected &&
      olderThanFloor.length > 0 &&
      retained.length === events.length,
    streamId,
    retainedCount: retained.length,
    olderThanFloorCount: olderThanFloor.length,
    oldestEventAgeMs: now - oldest,
    floorMs,
    compactionRejected,
  };
}

export function brokeredDeployCredentialTrail(options = {}) {
  const runId = options.runId ?? "deploy-cloudflare-42";
  const now = options.now ?? "2026-07-01T10:00:00.000Z";
  const actor = {
    kind: "agent",
    id: "agent:deploy",
    delegatedBy: { kind: "user", id: "user:priya" },
  };
  const correlationId = `run:${runId}:credentials`;

  const events = [
    createIdentityEvent(
      "identity.Issued",
      {
        identityId: "svid-deploy-1",
        subject: actor,
        svidRef: "identity://svid/deploy-1",
        scope: [{ port: "cloudflare", resource: "zone/example.com", actions: ["deploy"] }],
        expiresAt: "2026-07-01T10:15:00.000Z",
      },
      { id: "evt-identity", actor, seq: 1, correlationId, time: now },
    ),
    createIdentityEvent(
      "token.Granted",
      {
        grantId: "grant-cf-deploy",
        subject: actor,
        target: { kind: "provider", id: "cloudflare" },
        audience: "urn:cloudflare:workers",
        scopes: ["workers:deploy"],
        tokenRef: "vault://tokens/grant-cf-deploy",
        expiresAt: "2026-07-01T10:10:00.000Z",
      },
      { id: "evt-grant", actor, seq: 2, correlationId, causationId: "evt-identity", time: now },
    ),
    createIdentityEvent(
      "token.Used",
      {
        grantId: "grant-cf-deploy",
        usageId: "use-cf-deploy",
        operation: "workers.deploy",
        resource: "cloudflare:worker/hello-bindle",
      },
      { id: "evt-used", actor, seq: 3, correlationId, causationId: "evt-grant", time: now },
    ),
    createIdentityEvent(
      "token.Revoked",
      {
        grantId: "grant-cf-deploy",
        reason: "deploy completed",
      },
      { id: "evt-revoke", actor, seq: 4, correlationId, causationId: "evt-used", time: now },
    ),
  ];

  return { runId, correlationId, events };
}

function buildPrincipalTimelines(events) {
  const timelines = new Map();

  for (const event of events) {
    const principals = principalsForEvent(event);
    for (const principalId of principals) {
      if (!timelines.has(principalId)) {
        timelines.set(principalId, { principalId, entries: [] });
      }
      timelines.get(principalId).entries.push({
        seq: event.seq,
        time: event.time,
        type: event.type,
        eventId: event.id,
        grantId: event.data?.grantId ?? null,
        usageId: event.data?.usageId ?? null,
      });
    }
  }

  for (const timeline of timelines.values()) {
    timeline.entries.sort((left, right) => left.seq - right.seq);
  }

  return Object.fromEntries([...timelines.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function principalsForEvent(event) {
  const principals = new Set();
  if (event.actor?.id) {
    principals.add(principalKey(event.actor));
  }
  if (event.data?.subject) {
    principals.add(principalKey(event.data.subject));
    if (event.data.subject.delegatedBy) {
      principals.add(principalKey(event.data.subject.delegatedBy));
    }
  }
  if (event.data?.principal) {
    principals.add(principalKey(event.data.principal));
  }
  return [...principals];
}

function principalKey(principal) {
  return `${principal.kind}:${String(principal.id).replace(/^(user|agent|service):/, "")}`;
}

function assertCredentialAuditView(view) {
  if (!view || view.view !== CREDENTIAL_AUDIT_VIEW) {
    throw new TypeError("view must be a CredentialAuditView snapshot");
  }
}

function attachSourceEvents(view, sourceEvents) {
  return Object.freeze({
    ...view,
    __events: Object.freeze([...sourceEvents]),
  });
}

function eventSeq(event) {
  if (!Number.isSafeInteger(event?.seq) || event.seq < 0) {
    throw new TypeError("event.seq must be a non-negative safe integer");
  }
  return event.seq;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function compareEvents(left, right) {
  return eventSeq(left) - eventSeq(right) || String(left.id).localeCompare(String(right.id));
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}
