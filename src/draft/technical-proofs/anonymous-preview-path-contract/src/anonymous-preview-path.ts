import { createHash, randomBytes } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


const DEFAULT_TTL_HOURS = 24;
const DEFAULT_PREVIEW_DOMAIN = "preview.hobo.dev";
const MIN_NONCE_BITS = 128;

export function createAnonymousPreviewPlan(request, options = {}) {
  const normalized = normalizeRequest(request);
  const now = toDate(options.now ?? new Date());
  const events = [
    event("anonymousPreview.Requested", now, {
      command: normalized.command,
      project: normalized.project.name,
    }),
  ];

  if (normalized.identity) {
    return blockedPlan({
      code: "anonymous.identity-present",
      reason: "anonymous preview path only applies when no identity is available",
      now,
      events,
    });
  }
  if (normalized.camp) {
    return blockedPlan({
      code: "anonymous.camp-present",
      reason: "anonymous preview path only applies when no Camp is selected",
      now,
      events,
    });
  }

  const abuseGate = normalized.abuseGate;
  if (abuseGate.status !== "approved") {
    return blockedPlan({
      code: abuseGate.code ?? "anonymous.abuse-denied",
      reason: abuseGate.reason ?? "anonymous preview blocked by abuse controls",
      now,
      events,
      retryAfterSeconds: abuseGate.retryAfterSeconds ?? null,
    });
  }

  const policyGate = normalized.hostedPolicyGate;
  if (policyGate.status !== "approved") {
    return blockedPlan({
      code: policyGate.code ?? "hosted.policy-denied",
      reason: policyGate.reason ?? "hosted anonymous preview policy denied this deployment",
      now,
      events,
    });
  }

  if (!normalized.hostedCloud.autoApproveInferredCamp) {
    return blockedPlan({
      code: "hosted.inferred-camp-auto-approval-disabled",
      reason: "hosted anonymous preview requires inferred-Camp auto-approval",
      now,
      events,
    });
  }

  const ttlHours = options.ttlHours ?? DEFAULT_TTL_HOURS;
  const expiresAt = addHours(now, ttlHours);
  const idFactory = options.idFactory ?? ((prefix) => `${prefix}-${randomBytes(8).toString("hex")}`);
  const deploymentId = idFactory("anonymous-preview");
  const nonce = previewNonce(options.nonceFactory);
  const projectSlug = slug(normalized.project.name);
  const url = `https://${projectSlug}-${nonce}.${normalized.hostedCloud.previewDomain}`;
  const tenantId = `tenant:anonymous-preview:${deploymentId}`;
  const campId = `camp:anonymous-preview:${deploymentId}`;
  const claimRef = `claim:${deploymentId}`;
  const stateDigest = digest({
    project: normalized.project,
    url,
    tenantId,
    campId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  const deployment = {
    id: deploymentId,
    ownerAccountId: null,
    ownership: "unowned",
    claimable: true,
    claimRef,
    tenantId,
    url,
    state: "active",
    stateDigest,
    createdAt: now.toISOString(),
    camp: {
      id: campId,
      provider: normalized.hostedCloud.name,
      envType: "ephemeral",
      inferred: true,
      approval: "auto-approved",
      policyId: policyGate.policyId ?? null,
    },
    ttl: {
      hours: ttlHours,
      expiresAt: expiresAt.toISOString(),
      enforcedBy: "hosted-preview-reaper",
    },
    grants: [
      {
        tenantId,
        operations: ["read", "write", "teardown"],
      },
    ],
  };
  const record = {
    kind: "hobo.anonymous-preview-record.v1",
    deploymentId,
    ownerAccountId: null,
    ownership: "unowned",
    claimable: true,
    claimRef,
    url,
    state: deployment.state,
    stateDigest,
    tenantId,
    expiresAt: expiresAt.toISOString(),
    ttlHours,
  };

  events.push(
    event("anonymousPreview.InferredCampApproved", now, {
      campId,
      policyId: policyGate.policyId ?? null,
    }),
    event("anonymousPreview.DeploymentRecorded", now, {
      deploymentId,
      ownerAccountId: null,
      claimRef,
      url,
    }),
    event("anonymousPreview.TtlScheduled", now, {
      deploymentId,
      expiresAt: expiresAt.toISOString(),
      ttlHours,
    }),
  );

  return {
    status: "ready",
    route: "hosted-anonymous-preview",
    invocation: {
      executable: "npx",
      package: "hobo",
      args: ["up"],
      priorInstallRequired: false,
    },
    deployment,
    record,
    url,
    message: `Live URL ${url} is ephemeral with a 24h TTL. Claim it with: hobo claim ${claimRef}`,
    events,
  };
}

export function createClaimHandoff(record) {
  if (!record?.claimable || !record.claimRef) {
    throw new Error("claim handoff requires a claimable anonymous preview record");
  }

  return {
    kind: "hobo.anonymous-preview-claim-handoff.v1",
    implementedBy: "HOBO-136",
    claimCommand: `hobo claim ${record.claimRef}`,
    preserves: {
      deploymentId: record.deploymentId,
      url: record.url,
      stateDigest: record.stateDigest,
    },
  };
}

export function expireAnonymousPreview(record, options = {}) {
  const normalized = normalizeRecord(record);
  const now = toDate(options.now ?? new Date());
  const expiresAt = toDate(normalized.expiresAt);

  if (normalized.state !== "active" || now < expiresAt) {
    return {
      action: "none",
      record: normalized,
      events: [],
    };
  }

  const expired = {
    ...normalized,
    state: "expired",
    expiredAt: now.toISOString(),
  };

  return {
    action: "teardown",
    record: expired,
    events: [
      event("anonymousPreview.TtlExpired", now, {
        deploymentId: normalized.deploymentId,
        expiredAt: normalized.expiresAt,
      }),
      event("anonymousPreview.TeardownRequested", now, {
        deploymentId: normalized.deploymentId,
        url: normalized.url,
      }),
    ],
  };
}

export function authorizeAnonymousPreviewAccess(deployment, request) {
  if (!deployment?.tenantId) {
    throw new Error("deployment.tenantId is required");
  }
  const tenantId = requireString(request?.tenantId, "tenantId");
  const operation = requireString(request?.operation, "operation");

  if (tenantId === deployment.tenantId) {
    const grant = (deployment.grants ?? []).find((item) => item.tenantId === tenantId);
    if (!grant || !grant.operations?.includes(operation)) {
      return {
        decision: "deny",
        code: "anonymous.operation-denied",
        reason: `anonymous preview cannot ${operation} without an explicit tenant grant`,
      };
    }
    return {
      decision: "allow",
      tenantId,
      operation,
    };
  }

  return {
    decision: "deny",
    code: "anonymous.cross-tenant-denied",
    reason: `anonymous preview ${deployment.id} cannot ${operation} ${tenantId}`,
  };
}

function blockedPlan({ code, reason, now, events, retryAfterSeconds = null }) {
  return {
    status: "blocked",
    code,
    reason,
    retryAfterSeconds,
    route: "hosted-anonymous-preview",
    deployment: null,
    record: null,
    url: null,
    events: [
      ...events,
      event("anonymousPreview.Blocked", now, {
        code,
        reason,
      }),
    ],
  };
}

function normalizeRequest(request) {
  if (!request || !isJsonObject(request)) {
    throw new Error("request is required");
  }
  const project = request.project ?? {};
  const hostedCloud = request.hostedCloud ?? {};

  if (request.command !== "npx hobo up") {
    throw new Error('anonymous preview contract is for command "npx hobo up"');
  }

  return {
    command: request.command,
    identity: request.identity ?? null,
    camp: request.camp ?? null,
    project: {
      name: requireString(project.name, "project.name"),
      directory: project.directory ?? null,
      bindleDigest: project.bindleDigest ?? null,
    },
    hostedCloud: {
      name: hostedCloud.name ?? "hobo-hosted",
      previewDomain: normalizePreviewDomain(hostedCloud.previewDomain ?? DEFAULT_PREVIEW_DOMAIN),
      autoApproveInferredCamp: Boolean(hostedCloud.autoApproveInferredCamp),
    },
    hostedPolicyGate: request.hostedPolicyGate ?? { status: "denied", reason: "missing hosted policy gate result" },
    abuseGate: request.abuseGate ?? { status: "denied", reason: "missing abuse gate result" },
  };
}

function normalizeRecord(record) {
  if (!record || !isJsonObject(record)) {
    throw new Error("anonymous preview record is required");
  }
  return {
    ...record,
    deploymentId: requireString(record.deploymentId, "record.deploymentId"),
    url: requireString(record.url, "record.url"),
    state: record.state ?? "active",
    expiresAt: requireString(record.expiresAt, "record.expiresAt"),
  };
}

function normalizePreviewDomain(value) {
  const domain = requireString(value, "previewDomain").toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes("..")) {
    throw new Error(`invalid preview domain ${value}`);
  }
  return domain;
}

function previewNonce(nonceFactory) {
  const rawNonce = nonceFactory ? nonceFactory() : randomBytes(16).toString("hex");
  const nonce = String(rawNonce).toLowerCase();
  const bits = /^[a-z0-9]+$/.test(nonce) ? nonce.length * Math.log2(36) : 0;

  if (bits < MIN_NONCE_BITS) {
    throw new Error("anonymous preview nonce must be at least 128 bits and URL-label safe");
  }

  return nonce;
}

function event(type, occurredAt, data = {}) {
  return {
    id: `event:${type}:${digest({ occurredAt: occurredAt.toISOString(), data }).slice(0, 16)}`,
    type,
    occurredAt: occurredAt.toISOString(),
    data,
  };
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid timestamp ${value}`);
  }
  return date;
}

function slug(value) {
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new Error(`value ${value} cannot be slugged`);
  }

  return normalized;
}

function requireString(value, label) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}
