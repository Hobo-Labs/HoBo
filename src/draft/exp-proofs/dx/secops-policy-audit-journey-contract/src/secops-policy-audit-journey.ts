import { createHash } from "node:crypto";

import { createIdentityEvent, foldCredentialAudit } from "../../../../technical-proofs/identity-event-contract/src/identity-event-contract.js";
import { createPolicyAuditEvent } from "../../../api/policy-audit-export-contract/src/policy-audit-export.js";
import { runHoboUp, sampleSnapshopProject } from "../../../../technical-proofs/hobo-up-convergence-contract/src/up-convergence.js";
import { isJsonObject } from "./json.js";


export const SECOPS_POLICY_AUDIT_JOURNEY_VERSION = "hobo.secops-policy-audit-journey/v1";

const DENY_CEILING_SCOPES = Object.freeze(["object.delete"]);
const PACK_VERSION = "acme-baseline@4";
const PACK_DIGEST = `sha256:${"7f31".repeat(16)}`;
const POLICY_IDS = Object.freeze(["policy:prod-object-delete-deny-ceiling"]);

export async function runSecopsPolicyAuditJourney(input = {}) {
  const now = iso(input.now ?? "2026-06-28T10:04:00.000Z");
  const commandSurface = input.commandSurface ?? "cli";
  const allowRequest = normalizeAllowRequest(input.allowRequest);
  const waiver = input.waiver === undefined ? null : input.waiver;
  const runId = input.runId ?? `secops-${hash(canonicalJson({ commandSurface, allowRequest, waiver, now })).slice(0, 8)}`;
  const subjectRef = commandSurface === "mcp" ? "agent:hobo-cli" : "user:deployer";
  const waiverStatus = classifyWaiver(waiver, now);
  const allowAnalysis = analyzeAllow(allowRequest, waiverStatus);
  const replayRequest = {
    subjectRef,
    action: "hobo:deployment:apply",
    resourceRef: "deployment:snapshop-prod",
    phase: "apply",
    camp: "prod",
    scopes: allowRequest.scopes,
    commandSurface,
    mandatoryDenyCeiling: DENY_CEILING_SCOPES,
    waiverStatus: waiverStatus.status,
    waiverId: waiver?.id ?? null,
    waiverExpiresAt: waiver?.expiresAt ?? null,
  };
  const evaluated = evaluateReplayRequest(replayRequest);
  const policyDecision = makePolicyDecision({ runId, now, replayRequest, evaluated });
  const waiverEvents = makeWaiverEvents({ runId, now, waiver, waiverStatus, policyDecision });

  const up = await runHoboUp(
    {
      project: sampleSnapshopProject({
        defaultCampId: "prod",
        currentRevision: "rev-secops-audit",
      }),
      flags: { camp: "prod", json: true },
    },
    {
      now: () => now,
      idFactory: deterministicIdFactory(runId),
      evaluateGate: () =>
        evaluated.effect === "allow"
          ? { status: "passed", gateId: `gate-${runId}` }
          : {
              status: "failed",
              code: "policy.denied",
              reason: evaluated.reason,
              fix: "inspect policy.Decided and request a separated-duty waiver",
            },
    },
  );

  const credentialEvents =
    evaluated.effect === "allow"
      ? makeCredentialEvents({ runId, now, scopes: allowRequest.scopes, commandSurface })
      : [];
  const events = [
    policyDecision,
    ...waiverEvents.filter((event) => event.type === "policy.WaiverApproved"),
    ...up.events,
    ...credentialEvents,
    ...waiverEvents.filter((event) => event.type === "policy.WaiverExpired"),
  ];
  const output = renderCommandOutput({ evaluated, policyDecision, commandSurface });

  return freeze({
    status: evaluated.effect === "allow" ? "deployed" : "denied",
    runId,
    command: commandSurface === "mcp" ? "MCP deploy -> hobo up --camp prod" : "hobo up --camp prod",
    mcp: commandSurface === "mcp" ? { tool: "deploy", cliVerb: "up", gatedBy: "policy.Decided" } : null,
    decision: {
      effect: evaluated.effect,
      reason: evaluated.reason,
    },
    replay: {
      inputHash: policyDecision.data.evidence.inputHash,
      request: replayRequest,
    },
    allowAnalysis,
    up,
    provisionedResourceIds: up.events
      .filter((event) => event.type === "resource.Provisioned")
      .map((event) => event.data.resourceId),
    output,
    secretLeakFindings: findSecretLeaks(output),
    events,
  });
}

export function replaySecopsPolicyDecision(event) {
  if (!event || event.type !== "policy.Decided") {
    throw new Error("policy.Decided event is required");
  }
  const request = event.data?.evidence?.replayRequest;
  if (!request) {
    throw new Error("policy.Decided event is missing replayRequest evidence");
  }
  const inputHash = hash(canonicalJson(request));
  if (event.data.evidence.inputHash !== inputHash) {
    throw new Error("policy.Decided replay input hash mismatch");
  }
  return freeze({
    ...evaluateReplayRequest(request),
    inputHash,
  });
}

export function reconstructRunCredentialAudit(events, runId) {
  return foldCredentialAudit(
    events.filter(
      (event) =>
        event?.schemaVersion === "hobo.identity-events/v1" &&
        event.correlationId === `run:${runId}:credentials`,
    ),
  );
}

function evaluateReplayRequest(request) {
  if (request.waiverStatus === "self-approved") {
    return { effect: "deny", reason: "self-approved waiver rejected by separation-of-duties" };
  }
  if (request.waiverStatus === "expired") {
    return { effect: "deny", reason: "waiver expired before hobo up" };
  }

  const deniedScopes = request.scopes.filter((scope) => request.mandatoryDenyCeiling.includes(scope));
  if (deniedScopes.length > 0 && request.waiverStatus !== "valid") {
    return { effect: "deny", reason: "mandatory deny-ceiling blocks object.delete in prod" };
  }
  if (deniedScopes.length > 0) {
    return {
      effect: "allow",
      reason: `separated-duty waiver permits ${deniedScopes.join(", ")} until ${request.waiverExpiresAt}`,
    };
  }

  return {
    effect: "allow",
    reason: "mandatory deny-ceiling honored; .allow() only narrows",
  };
}

function analyzeAllow(allowRequest, waiverStatus) {
  const deniedScopes = allowRequest.scopes.filter((scope) => DENY_CEILING_SCOPES.includes(scope));
  if (deniedScopes.length === 0) {
    return freeze({
      status: "narrowed",
      widened: false,
      effectiveScopes: allowRequest.scopes,
      deniedCeilingScopes: DENY_CEILING_SCOPES,
    });
  }
  return freeze({
    status: waiverStatus.status === "valid" ? "widening-waived" : "widening-rejected",
    widened: true,
    effectiveScopes: allowRequest.scopes,
    deniedCeilingScopes: DENY_CEILING_SCOPES,
    violation: "lower-scope .allow() intersects a mandatory deny-ceiling",
  });
}

function classifyWaiver(waiver, now) {
  if (!waiver) {
    return { status: "none" };
  }
  if (waiver.author && waiver.approver && waiver.author === waiver.approver) {
    return { status: "self-approved" };
  }
  if (waiver.expiresAt && Date.parse(waiver.expiresAt) <= Date.parse(now)) {
    return { status: "expired" };
  }
  return { status: "valid" };
}

function makePolicyDecision({ runId, now, replayRequest, evaluated }) {
  const inputHash = hash(canonicalJson(replayRequest));
  return createPolicyAuditEvent(
    "policy.Decided",
    {
      decisionId: `decision-${runId}`,
      requestId: `request-${runId}`,
      subjectRef: replayRequest.subjectRef,
      action: replayRequest.action,
      resourceRef: replayRequest.resourceRef,
      effect: evaluated.effect,
      reason: evaluated.reason,
      packVersion: PACK_VERSION,
      packDigest: PACK_DIGEST,
      policyIds: [...POLICY_IDS],
      violations: evaluated.effect === "deny" ? [evaluated.reason] : [],
      obligations: replayRequest.waiverStatus === "valid" ? [{ id: `waiver-${runId}`, kind: "waiver.ttl" }] : [],
      evidence: {
        inputHash,
        engine: SECOPS_POLICY_AUDIT_JOURNEY_VERSION,
        replayRequest,
      },
    },
    {
      id: `evt-policy-decided-${runId}`,
      seq: 1,
      time: now,
      actor: { kind: "service", id: "yard/policy-plane" },
      correlationId: `run:${runId}:policy`,
      causationId: `cmd:${runId}:up`,
    },
  );
}

function makeWaiverEvents({ runId, now, waiver, waiverStatus, policyDecision }) {
  if (!waiver) {
    return [];
  }
  const baseData = {
    decisionId: policyDecision.data.decisionId,
    requestId: policyDecision.data.requestId,
    subjectRef: policyDecision.data.subjectRef,
    action: policyDecision.data.action,
    resourceRef: policyDecision.data.resourceRef,
    waiverId: waiver.id ?? `waiver-${runId}`,
    reason: waiver.reason ?? "time-boxed SecOps exception",
    packVersion: PACK_VERSION,
    packDigest: PACK_DIGEST,
    policyIds: [...POLICY_IDS],
  };
  const events = [];

  if (waiverStatus.status === "valid" || waiverStatus.status === "expired") {
    events.push(
      createPolicyAuditEvent(
        "policy.WaiverApproved",
        {
          ...baseData,
          approvedBy: waiver.approver,
          expiresAt: waiver.expiresAt,
        },
        {
          id: `evt-policy-waiver-approved-${runId}`,
          seq: 2,
          time: waiver.approvedAt ?? now,
          actor: principalFromRef(waiver.approver ?? "user:security-admin"),
          correlationId: `run:${runId}:policy`,
          causationId: policyDecision.id,
        },
      ),
    );
  }

  if (waiver.expiresAt && (waiverStatus.status === "valid" || waiverStatus.status === "expired")) {
    events.push(
      policyWaiverExpiredEvent({
        runId,
        waiver,
        data: baseData,
        causationId: events.at(-1)?.id ?? policyDecision.id,
      }),
    );
  }

  return events;
}

function policyWaiverExpiredEvent({ runId, waiver, data, causationId }) {
  return freeze({
    id: `evt-policy-waiver-expired-${runId}`,
    type: "policy.WaiverExpired",
    schemaVersion: "hobo.policy-audit-events/v1",
    orgId: "org:acme",
    tenant: "tenant-acme",
    streamId: "org:acme/policy-audit",
    seq: 3,
    time: waiver.expiresAt,
    actor: { kind: "service", id: "yard/policy-plane" },
    correlationId: `run:${runId}:policy`,
    causationId,
    retention: {
      class: "security-audit",
      neverCompact: true,
      streamPolicy: "retain-org-policy-audit-stream",
    },
    data: {
      ...data,
      expiredBy: "ttl",
      expiresAt: waiver.expiresAt,
    },
  });
}

function makeCredentialEvents({ runId, now, scopes, commandSurface }) {
  const actor = {
    kind: "agent",
    id: "agent:hobo-cli",
    delegatedBy: commandSurface === "cli" ? { kind: "user", id: "user:deployer" } : undefined,
  };
  const base = {
    actor,
    correlationId: `run:${runId}:credentials`,
    causationId: `evt-policy-decided-${runId}`,
    time: now,
  };

  return [
    createIdentityEvent(
      "token.Granted",
      {
        grantId: `grant-${runId}`,
        subject: actor,
        target: { kind: "provider", id: "yard-provider" },
        audience: "urn:hobo:prod:provider",
        scopes,
        tokenRef: `vault://tokens/grant-${runId}`,
        expiresAt: addMinutes(now, 10),
      },
      { ...base, id: `evt-token-granted-${runId}`, seq: 1 },
    ),
    createIdentityEvent(
      "token.Used",
      {
        grantId: `grant-${runId}`,
        usageId: `use-${runId}`,
        operation: "hobo.up.apply",
        resource: "deployment:snapshop-prod",
      },
      { ...base, id: `evt-token-used-${runId}`, seq: 2, causationId: `evt-token-granted-${runId}` },
    ),
    createIdentityEvent(
      "token.Revoked",
      {
        grantId: `grant-${runId}`,
        reason: "hobo up completed",
      },
      { ...base, id: `evt-token-revoked-${runId}`, seq: 3, causationId: `evt-token-used-${runId}` },
    ),
  ];
}

function renderCommandOutput({ evaluated, policyDecision, commandSurface }) {
  const prefix = commandSurface === "mcp" ? "mcp deploy\nhobo up --camp prod" : "hobo up --camp prod";
  const gate = evaluated.effect === "allow" ? "gate: policy ok" : "gate: policy X";
  const summary = evaluated.effect === "allow" ? "ALLOWED" : "DENIED";
  return `${prefix}\n${gate}\n${summary} ${evaluated.reason}\npolicy.Decided ${policyDecision.data.packVersion} audit:${policyDecision.data.decisionId}\n`;
}

function findSecretLeaks(output) {
  const matches = output.match(/(AKIA[0-9A-Z]+|eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_.-]+|provider-token-[a-zA-Z0-9_-]+)/g);
  return matches ? [...matches] : [];
}

function normalizeAllowRequest(allowRequest = {}) {
  return freeze({
    scopes: [...new Set(allowRequest.scopes ?? ["object.read"])].sort(),
  });
}

function principalFromRef(ref) {
  const [kind, ...rest] = String(ref).split(":");
  const id = rest.length > 0 ? `${kind}:${rest.join(":")}` : String(ref);
  return { kind, id };
}

function deterministicIdFactory(runId) {
  let next = 1;
  return (prefix) => `${prefix}-${runId}-${next++}`;
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function iso(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid ISO time: ${value}`);
  }
  return parsed.toISOString();
}

function addMinutes(value, minutes) {
  return new Date(Date.parse(value) + minutes * 60_000).toISOString();
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
