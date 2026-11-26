import {
  POLICY_IR_SCHEMA_VERSION,
  createDecision,
  createDecisionRequest,
  createPolicyDecidedEvent,
} from "../../hobo-policy-ir-contract/src/policy-ir.js";
import { isJsonString, isJsonObject } from "./json.js";


export const CONTROL_PLANE_AUTHZ_CACHE_CONTRACT_VERSION = "hobo.control-plane-authz-cache/v1";
export const CONTROL_PLANE_AUTHZ_ENGINE_ID = "hobo.control-plane-authz-cache@0.1.0";

export const CONTROL_PLANE_AUTHZ_NFR = Object.freeze({
  p99TargetMs: 25,
  crewOperatorRepairLoopP99TargetMs: 10,
  decisionCacheTtlMs: 300_000,
  revocationPropagationBoundMs: 30_000,
  localEvaluationCostMs: 6,
  cacheHitCostMs: 0.2,
  revocationCheckCostMs: 0.05,
  auditEnqueueCostMs: 0.05,
});

export function createManualClock(startMs = 0) {
  let currentMs = normalizeMs(startMs, "startMs");

  return {
    nowMs() {
      return currentMs;
    },
    set(nextMs) {
      currentMs = normalizeMs(nextMs, "nextMs");
      return currentMs;
    },
    advance(deltaMs) {
      const delta = normalizeMs(deltaMs, "deltaMs");
      currentMs += delta;
      return currentMs;
    },
  };
}

export function createControlPlaneAuthorizer({
  policyEvaluator,
  clock = createManualClock(),
  nfr = CONTROL_PLANE_AUTHZ_NFR,
  auditSink = async () => {},
} = {}) {
  if (!(policyEvaluator instanceof Function)) {
    throw new TypeError("policyEvaluator must be a function");
  }
  if (!clock || !(clock.nowMs instanceof Function)) {
    throw new TypeError("clock must expose nowMs()");
  }
  if (!(auditSink instanceof Function)) {
    throw new TypeError("auditSink must be a function");
  }

  const bounds = normalizeNfr(nfr);
  const decisionCache = new Map();
  const revocations = new Map();
  const auditQueue = [];
  const metrics = {
    cacheHits: 0,
    cacheMisses: 0,
    localEvaluations: 0,
    managementPlaneCalls: 0,
    auditEventsQueued: 0,
    revocationsApplied: 0,
    latencySamplesMs: [],
  };
  let auditSequence = 0;

  function evaluate(input) {
    const evaluationInput = normalizeEvaluationInput(input);
    const request = createDecisionRequest(evaluationInput.request);
    const nowMs = normalizeMs(evaluationInput.nowMs ?? clock.nowMs(), "nowMs");
    const packVersion = requireString(evaluationInput.packVersion, "packVersion");
    const packDigest = requireString(evaluationInput.packDigest, "packDigest");

    const activeRevocation = findActiveRevocation({ request, revocations, nowMs });
    if (activeRevocation) {
      const decision = createRevocationDenyDecision(request, activeRevocation);
      const latencyMs = bounds.revocationCheckCostMs + bounds.auditEnqueueCostMs;
      recordLatency(metrics, latencyMs);
      enqueueAudit({
        request,
        decision,
        cacheHit: false,
        packVersion,
        packDigest,
        latencyMs,
      });
      return {
        decision,
        cacheHit: false,
        revoked: true,
        latencyMs,
        cacheExpiresAtMs: null,
        packVersion,
      };
    }

    const key = decisionCacheKey(request, { packVersion, packDigest });
    const cached = decisionCache.get(key);
    if (cached && cached.expiresAtMs > nowMs) {
      metrics.cacheHits += 1;
      const latencyMs = bounds.cacheHitCostMs + bounds.revocationCheckCostMs + bounds.auditEnqueueCostMs;
      recordLatency(metrics, latencyMs);
      enqueueAudit({
        request,
        decision: cached.decision,
        cacheHit: true,
        packVersion,
        packDigest,
        latencyMs,
      });
      return {
        decision: structuredClone(cached.decision),
        cacheHit: true,
        revoked: false,
        latencyMs,
        cacheExpiresAtMs: cached.expiresAtMs,
        packVersion,
      };
    }

    metrics.cacheMisses += 1;
    metrics.localEvaluations += 1;
    const evaluated = policyEvaluator({ request, packVersion, packDigest, nowMs });
    const decision = createDecision(request, {
      effect: evaluated.effect,
      reason: evaluated.reason,
      violations: evaluated.violations ?? [],
      mutations: evaluated.mutations ?? [],
      approvals: evaluated.approvals ?? [],
      obligations: evaluated.obligations ?? [],
      evidence: {
        engine: evaluated.engine ?? CONTROL_PLANE_AUTHZ_ENGINE_ID,
        policyIds: evaluated.policyIds ?? [],
      },
    });
    const expiresAtMs = nowMs + bounds.decisionCacheTtlMs;
    decisionCache.set(key, {
      decision,
      cachedAtMs: nowMs,
      expiresAtMs,
      subjectId: request.subject.id,
      subjectRoles: request.subject.roles ?? [],
      packVersion,
      packDigest,
    });

    const latencyMs = bounds.localEvaluationCostMs + bounds.revocationCheckCostMs + bounds.auditEnqueueCostMs;
    recordLatency(metrics, latencyMs);
    enqueueAudit({
      request,
      decision,
      cacheHit: false,
      packVersion,
      packDigest,
      latencyMs,
    });

    return {
      decision: structuredClone(decision),
      cacheHit: false,
      revoked: false,
      latencyMs,
      cacheExpiresAtMs: expiresAtMs,
      packVersion,
    };
  }

  function observeRoleRevocation({ subjectId, role, revokedAtMs, observedAtMs, sequence }) {
    const normalizedSubjectId = requireString(subjectId, "subjectId");
    const normalizedRole = requireString(role, "role");
    const revokedAt = normalizeMs(revokedAtMs, "revokedAtMs");
    const observedAt = normalizeMs(observedAtMs ?? clock.nowMs(), "observedAtMs");
    if (observedAt - revokedAt > bounds.revocationPropagationBoundMs) {
      throw new Error(
        `revocation propagation exceeded bound: ${observedAt - revokedAt}ms > ${bounds.revocationPropagationBoundMs}ms`,
      );
    }

    const revocation = {
      subjectId: normalizedSubjectId,
      role: normalizedRole,
      revokedAtMs: revokedAt,
      observedAtMs: observedAt,
      effectiveAtMs: observedAt,
      sequence: sequence ?? `${normalizedSubjectId}:${normalizedRole}:${observedAt}`,
      propagationBoundMs: bounds.revocationPropagationBoundMs,
    };
    revocations.set(revocationKey(normalizedSubjectId, normalizedRole), revocation);
    invalidateSubjectRoleCache(decisionCache, normalizedSubjectId, normalizedRole);
    metrics.revocationsApplied += 1;
    return structuredClone(revocation);
  }

  async function flushAuditEvents() {
    await Promise.resolve();
    const events = auditQueue.splice(0, auditQueue.length);
    for (const event of events) {
      await auditSink(event);
    }
    return events.map((event) => structuredClone(event));
  }

  function enqueueAudit({ request, decision, cacheHit, packVersion, packDigest, latencyMs }) {
    auditSequence += 1;
    const event = createPolicyDecidedEvent({
      request,
      decision,
      id: `policy-decided-control-plane-authz-${auditSequence}`,
    });
    auditQueue.push({
      ...event,
      metadata: {
        contract: CONTROL_PLANE_AUTHZ_CACHE_CONTRACT_VERSION,
        async: true,
        controlPlaneAuthz: {
          cacheHit,
          packVersion,
          packDigest,
          latencyMs,
          cacheTtlMs: bounds.decisionCacheTtlMs,
          revocationPropagationBoundMs: bounds.revocationPropagationBoundMs,
        },
      },
    });
    metrics.auditEventsQueued += 1;
  }

  return {
    contractVersion: CONTROL_PLANE_AUTHZ_CACHE_CONTRACT_VERSION,
    nfr: bounds,
    clock,
    evaluate,
    observeRoleRevocation,
    flushAuditEvents,
    cacheSize() {
      return decisionCache.size;
    },
    getMetrics() {
      return structuredClone(metrics);
    },
  };
}

export function runControlPlaneAuthzBenchmark({
  authorizer,
  request,
  packVersion,
  packDigest,
  iterations = 1_000,
} = {}) {
  if (!authorizer || !(authorizer.evaluate instanceof Function) || !(authorizer.getMetrics instanceof Function)) {
    throw new TypeError("authorizer must expose evaluate() and getMetrics()");
  }
  const count = normalizePositiveInteger(iterations, "iterations");
  const startingMetrics = authorizer.getMetrics();
  const decisions = [];

  for (let index = 0; index < count; index += 1) {
    decisions.push(
      authorizer.evaluate({
        request,
        packVersion,
        packDigest,
      }).decision.effect,
    );
  }

  const endingMetrics = authorizer.getMetrics();
  const newSamples = endingMetrics.latencySamplesMs.slice(startingMetrics.latencySamplesMs.length);
  const cacheHits = endingMetrics.cacheHits - startingMetrics.cacheHits;
  const cacheMisses = endingMetrics.cacheMisses - startingMetrics.cacheMisses;

  return {
    schema: "hobo.control-plane-authz-benchmark/v1",
    iterations: count,
    p99Ms: percentile(newSamples, 99),
    cacheHitRatio: cacheHits / count,
    cacheHits,
    cacheMisses,
    managementPlaneCalls: endingMetrics.managementPlaneCalls - startingMetrics.managementPlaneCalls,
    effects: [...new Set(decisions)],
  };
}

export function createCrewOperatorRepairLoopRequest(overrides = {}) {
  return deepMerge(
    {
      schemaVersion: POLICY_IR_SCHEMA_VERSION,
      subject: {
        kind: "agent",
        id: "agent:crew-operator/sre-repair",
        roles: ["Operator-Supervisor"],
        scopes: ["hobo:operator:dispatch"],
        delegatedBy: "user:incident-commander",
      },
      action: "hobo:operator:dispatch",
      resource: {
        kind: "hobo:operator",
        id: "operator:sre-repair-loop",
      },
      phase: "repair",
      context: {
        yard: "yard-prod",
        policyPackVersion: "policy-pack:prod-governance@1",
        policyPackDigest: "sha256:prod-governance-v1",
      },
    },
    overrides,
  );
}

function createRevocationDenyDecision(request, revocation) {
  return createDecision(request, {
    effect: "deny",
    reason: `role ${revocation.role} revoked within control-plane authz propagation bound`,
    violations: [
      `${revocation.subjectId} role ${revocation.role} revoked at ${revocation.revokedAtMs}`,
      `revocation observed at ${revocation.observedAtMs} within ${revocation.propagationBoundMs}ms bound`,
    ],
    obligations: [
      {
        kind: "audit.revocation-applied",
        subjectId: revocation.subjectId,
        role: revocation.role,
        sequence: revocation.sequence,
      },
    ],
    evidence: {
      engine: CONTROL_PLANE_AUTHZ_ENGINE_ID,
      policyIds: ["control-plane-authz.revocation-bound"],
    },
  });
}

function findActiveRevocation({ request, revocations, nowMs }) {
  for (const role of request.subject.roles ?? []) {
    const revocation = revocations.get(revocationKey(request.subject.id, role));
    if (revocation && nowMs >= revocation.effectiveAtMs) {
      return revocation;
    }
  }
  return null;
}

function invalidateSubjectRoleCache(decisionCache, subjectId, role) {
  for (const [key, entry] of decisionCache.entries()) {
    if (entry.subjectId === subjectId && entry.subjectRoles.includes(role)) {
      decisionCache.delete(key);
    }
  }
}

function decisionCacheKey(request, { packVersion, packDigest }) {
  return JSON.stringify({
    subjectId: request.subject.id,
    roles: [...(request.subject.roles ?? [])].sort(),
    action: request.action,
    resource: request.resource,
    phase: request.phase,
    context: request.context,
    packVersion,
    packDigest,
  });
}

function normalizeEvaluationInput(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new TypeError("evaluate input must be an object");
  }
  if (Object.hasOwn(input, "request")) {
    return input;
  }
  return {
    request: input,
    packVersion: input.context?.policyPackVersion,
    packDigest: input.context?.policyPackDigest,
  };
}

function normalizeNfr(nfr) {
  return {
    ...CONTROL_PLANE_AUTHZ_NFR,
    ...nfr,
  };
}

function recordLatency(metrics, latencyMs) {
  metrics.latencySamplesMs.push(latencyMs);
}

function percentile(samples, percentileValue) {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function revocationKey(subjectId, role) {
  return `${subjectId}\u0000${role}`;
}

function normalizeMs(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function normalizePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function requireString(value, name) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function deepMerge(base, overrides) {
  if (Array.isArray(base) || Array.isArray(overrides)) {
    return overrides === undefined ? structuredClone(base) : structuredClone(overrides);
  }
  if (!base || !isJsonObject(base)) {
    return overrides === undefined ? base : overrides;
  }

  const output = { ...structuredClone(base) };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    output[key] = deepMerge(output[key], value);
  }
  return output;
}
