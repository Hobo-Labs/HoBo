import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const PROMOTION_POLICY_REQUEST_SCHEMA = "hobo.policy-ir/v1";
export const PROMOTION_GATE_SCHEMA = "hobo.gen.promotion-gate/v1";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const policyAllowEffects = new Set(["allow", "allow-degraded", "warn", "mutate"]);
const knownRiskClasses = new Set(["low", "medium", "high"]);
const productionEnvironments = new Set(["prod", "production"]);

export class PromotionGateContractError extends Error {
  constructor(code, path = "$", message = code) {
    super(`${code} at ${path}: ${message}`);
    this.name = "PromotionGateContractError";
    this.code = code;
    this.path = path;
  }
}

export function buildPromotionPolicyRequest(candidateInput) {
  const candidate = parseCandidate(candidateInput);

  return {
    schema: PROMOTION_POLICY_REQUEST_SCHEMA,
    subject: candidate.subject,
    action: "gen.certify",
    resource: {
      kind: candidate.target.kind,
      id: candidate.target.id,
    },
    phase: "promote",
    context: {
      artifactKind: candidate.artifactKind,
      target: {
        witPort: candidate.target.witPort,
      },
      environment: candidate.environment,
      riskClass: candidate.riskClass,
      conformance: {
        passed: true,
        reportRef: candidate.conformance.reportRef,
      },
      evalResults: candidate.evalResults,
      candidateRef: candidate.candidateRef,
      provenanceRef: candidate.provenanceRef,
    },
  };
}

export function createGenerationPromotionGate({ policyEngine, ruleset } = {}) {
  if (!policyEngine || !(policyEngine.evaluate instanceof Function)) {
    throw new PromotionGateContractError(
      "promotion.policy_engine_required",
      "$.policyEngine",
      "policyEngine must implement evaluate(request, ruleset)",
    );
  }

  return {
    decide(candidateInput) {
      const candidate = parseCandidate(candidateInput);
      const policyRequest = buildPromotionPolicyRequest(candidate);
      const policyDecision = normalizePolicyDecision(
        policyEngine.evaluate(policyRequest, ruleset),
        policyEngine.engineId,
        policyRequest,
      );
      const finalDecision = deriveFinalDecision(candidate, policyDecision);
      const approvalHook =
        finalDecision.effect === "require-approval"
          ? createApprovalHook(candidate, policyDecision, finalDecision)
          : null;

      const events = [
        event(candidate, 1, "policy.Decided", {
          request: policyRequest,
          decision: policyDecision,
        }),
        event(candidate, 2, "gen.PromotionGateDecided", {
          runId: candidate.runId,
          finalDecision,
          policyInputHash: policyDecision.evidence.inputHash,
          policyIds: policyDecision.evidence.policyIds,
          approvalHook,
        }),
      ];

      if (approvalHook) {
        events.push(event(candidate, 3, "gen.ApprovalHookCreated", approvalHook));
      }

      if (finalDecision.effect === "certify") {
        events.push(certifiedEvent(candidate, events.length + 1, finalDecision, policyDecision));
      }

      return {
        effect: finalDecision.effect,
        certified: finalDecision.effect === "certify",
        policyRequest,
        policyDecision,
        finalDecision,
        approvalHook,
        events,
      };
    },

    certifyFromEvents(events) {
      const rebuilt = rebuildPromotionGateRun(events);
      if (rebuilt.finalDecision?.effect === "require-approval" && rebuilt.approval?.resolution !== "approved") {
        throw new PromotionGateContractError(
          "promotion.approval_unresolved",
          "$.events",
          "approval hook has not resolved",
        );
      }
      if (!rebuilt.certified) {
        throw new PromotionGateContractError(
          "promotion.not_certified",
          "$.events",
          "event stream does not contain gen.Certified",
        );
      }
      return rebuilt.certification;
    },

    resolveApproval(events, resolutionInput) {
      const rebuilt = rebuildPromotionGateRun(events);
      if (!rebuilt.approvalHook) {
        throw new PromotionGateContractError(
          "promotion.approval_hook_missing",
          "$.events",
          "approval resolution requires an approval hook",
        );
      }

      const resolution = parseApprovalResolution(resolutionInput);
      const candidate = candidateFromRebuilt(rebuilt, resolution.ts);
      const resolved = event(candidate, nextSeq(events), "gen.ApprovalHookResolved", {
        hookId: rebuilt.approvalHook.id,
        resolution: resolution.resolution,
        approvedBy: resolution.approvedBy,
      });

      const output = [resolved];
      if (resolution.resolution === "approved") {
        output.push(certifiedEvent(candidate, resolved.seq + 1, rebuilt.finalDecision, rebuilt.policyDecision));
      }

      return {
        certified: resolution.resolution === "approved",
        events: output,
      };
    },
  };
}

export function rebuildPromotionGateRun(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new PromotionGateContractError("promotion.events_required", "$");
  }

  const sorted = [...events].sort((left, right) => left.seq - right.seq);
  const state = {
    streamId: sorted[0].streamId,
    runId: sorted[0].correlationId,
    tenant: sorted[0].tenant,
    policyRequest: null,
    policyDecision: null,
    finalDecision: null,
    approvalHook: null,
    approval: null,
    certification: null,
    certified: false,
    eventTypes: [],
  };

  for (const current of sorted) {
    validateEvent(current, state.streamId);
    state.eventTypes.push(current.type);

    switch (current.type) {
      case "policy.Decided":
        state.policyRequest = current.data.request;
        state.policyDecision = current.data.decision;
        break;
      case "gen.PromotionGateDecided":
        state.finalDecision = current.data.finalDecision;
        if (current.data.approvalHook) {
          state.approvalHook = current.data.approvalHook;
        }
        break;
      case "gen.ApprovalHookCreated":
        state.approvalHook = current.data;
        break;
      case "gen.ApprovalHookResolved":
        state.approval = current.data;
        break;
      case "gen.Certified":
        state.certification = current.data;
        state.certified = true;
        break;
      default:
        throw new PromotionGateContractError("promotion.event_type", "$.type");
    }
  }

  return state;
}

function deriveFinalDecision(candidate, policyDecision) {
  if (policyDecision.effect === "deny") {
    return {
      effect: "deny",
      reason: policyDecision.reason,
    };
  }

  if (policyDecision.effect === "require-approval") {
    return {
      effect: "require-approval",
      reason: policyDecision.reason || "policy-requires-approval",
    };
  }

  if (!policyAllowEffects.has(policyDecision.effect)) {
    return {
      effect: "deny",
      reason: `policy-effect-not-certifiable:${policyDecision.effect}`,
    };
  }

  const approvalReason = approvalReasonFor(candidate);
  if (approvalReason) {
    return {
      effect: "require-approval",
      reason: approvalReason,
    };
  }

  return {
    effect: "certify",
    reason: policyDecision.reason || "policy-allowed-certification",
  };
}

function approvalReasonFor(candidate) {
  if (!knownRiskClasses.has(candidate.riskClass)) {
    return `unknown-risk-fail-closed:${candidate.riskClass}`;
  }
  if (productionEnvironments.has(candidate.environment)) {
    return "prod-requires-approval";
  }
  if (candidate.riskClass === "high") {
    return "high-risk-requires-approval";
  }
  if (candidate.trustClass === "high-trust") {
    return "high-trust-requires-approval";
  }
  return null;
}

function createApprovalHook(candidate, policyDecision, finalDecision) {
  const createHookObligation = policyDecision.obligations.find(
    (obligation) => obligation.kind === "createHook",
  );
  const id =
    createHookObligation?.id ??
    policyDecision.approvals.at(0) ??
    `hook:${candidate.runId}:generation-certify`;

  return {
    kind: "createHook",
    id,
    runId: candidate.runId,
    reason: finalDecision.reason,
    deadline: createHookObligation?.deadline ?? "PT30M",
  };
}

function certifiedEvent(candidate, seq, finalDecision, policyDecision) {
  return event(candidate, seq, "gen.Certified", {
    schema: "hobo.gen.result/v1",
    requestId: candidate.runId,
    candidateRef: candidate.candidateRef,
    validationReportRef: candidate.conformance.reportRef,
    provenanceRef: candidate.provenanceRef,
    gateDecision: {
      effect: "certify",
      reason: finalDecision.reason,
      policyRef: policyDecision.evidence.policyIds.at(0) ?? policyDecision.evidence.inputHash,
      policyInputHash: policyDecision.evidence.inputHash,
    },
  });
}

function event(candidate, seq, type, data) {
  return {
    id: `${candidate.runId}:${seq}:${type}`,
    type,
    v: 1,
    schema: PROMOTION_GATE_SCHEMA,
    streamId: `generation-promotion:${candidate.runId}`,
    seq,
    ts: candidate.ts,
    actor: candidate.subject,
    tenant: candidate.tenant ?? "tenant:unknown",
    correlationId: candidate.runId,
    data,
  };
}

function normalizePolicyDecision(decision, fallbackEngineId, request) {
  if (!decision || !isJsonObject(decision) || Array.isArray(decision)) {
    return {
      schema: "hobo.policy-ir.decision/v1",
      effect: "deny",
      reason: "policy engine returned an invalid decision",
      violations: ["decision must be an object"],
      mutations: [],
      approvals: [],
      obligations: [],
      evidence: {
        engine: fallbackEngineId ?? "unknown-policy-engine",
        inputHash: hashJson(request),
        policyIds: [],
      },
    };
  }

  return {
    schema: decision.schema ?? "hobo.policy-ir.decision/v1",
    effect: decision.effect ?? "deny",
    reason: decision.reason ?? "",
    violations: decision.violations ?? [],
    mutations: decision.mutations ?? [],
    approvals: decision.approvals ?? [],
    obligations: decision.obligations ?? [],
    evidence: {
      engine: decision.evidence?.engine ?? fallbackEngineId ?? "unknown-policy-engine",
      inputHash: decision.evidence?.inputHash ?? hashJson(request),
      policyIds: decision.evidence?.policyIds ?? [],
    },
  };
}

function parseCandidate(input) {
  const candidate = expectObject(input, "$");
  assertNonEmptyString(candidate.runId, "$.runId");
  const subject = parseSubject(candidate.subject, "$.subject");
  assertNonEmptyString(candidate.artifactKind, "$.artifactKind");
  const target = parseTarget(candidate.target, "$.target");
  const environment = assertNonEmptyString(candidate.environment, "$.environment");
  const riskClass = assertNonEmptyString(candidate.riskClass, "$.riskClass");

  if (candidate.conformance?.passed !== true) {
    throw new PromotionGateContractError(
      "promotion.conformance_not_green",
      "$.conformance.passed",
      "conformance must be green before policy promotion",
    );
  }
  const conformance = {
    passed: true,
    reportRef: parseDigestRef(candidate.conformance.reportRef, "$.conformance.reportRef"),
  };

  if (candidate.evalResults?.passed !== true) {
    throw new PromotionGateContractError(
      "promotion.eval_not_green",
      "$.evalResults.passed",
      "eval gate must be green before policy promotion",
    );
  }

  return {
    runId: candidate.runId,
    subject,
    artifactKind: candidate.artifactKind,
    target,
    environment,
    riskClass,
    trustClass: candidate.trustClass,
    conformance,
    evalResults: { ...candidate.evalResults },
    candidateRef: parseDigestRef(candidate.candidateRef, "$.candidateRef"),
    provenanceRef: parseDigestRef(candidate.provenanceRef, "$.provenanceRef"),
    ts: assertIsoTimestamp(candidate.ts, "$.ts"),
    tenant: candidate.tenant,
  };
}

function parseSubject(input, path) {
  const subject = expectObject(input, path);
  const parsed = {
    kind: assertNonEmptyString(subject.kind, `${path}.kind`),
    id: assertNonEmptyString(subject.id, `${path}.id`),
  };
  if (subject.roles !== undefined) {
    parsed.roles = parseStringArray(subject.roles, `${path}.roles`);
  }
  if (subject.scopes !== undefined) {
    parsed.scopes = parseStringArray(subject.scopes, `${path}.scopes`);
  }
  return parsed;
}

function parseTarget(input, path) {
  const target = expectObject(input, path);
  return {
    kind: assertNonEmptyString(target.kind, `${path}.kind`),
    id: assertNonEmptyString(target.id, `${path}.id`),
    witPort: assertNonEmptyString(target.witPort, `${path}.witPort`),
  };
}

function parseDigestRef(input, path) {
  const ref = expectObject(input, path);
  const parsed = {
    uri: assertNonEmptyString(ref.uri, `${path}.uri`),
    digest: assertNonEmptyString(ref.digest, `${path}.digest`),
  };
  if (!digestPattern.test(parsed.digest)) {
    throw new PromotionGateContractError("promotion.digest_ref", `${path}.digest`);
  }
  return parsed;
}

function parseApprovalResolution(input) {
  const resolution = expectObject(input, "$.approval");
  const parsed = {
    approvedBy: assertNonEmptyString(resolution.approvedBy, "$.approval.approvedBy"),
    resolution: assertNonEmptyString(resolution.resolution, "$.approval.resolution"),
    ts: assertIsoTimestamp(resolution.ts, "$.approval.ts"),
  };
  if (!["approved", "rejected"].includes(parsed.resolution)) {
    throw new PromotionGateContractError("promotion.approval_resolution", "$.approval.resolution");
  }
  return parsed;
}

function candidateFromRebuilt(rebuilt, ts) {
  const request = expectObject(rebuilt.policyRequest, "$.policyRequest");
  const context = expectObject(request.context, "$.policyRequest.context");
  return {
    runId: rebuilt.runId,
    subject: request.subject,
    artifactKind: context.artifactKind,
    target: {
      kind: request.resource.kind,
      id: request.resource.id,
      witPort: context.target.witPort,
    },
    environment: context.environment,
    riskClass: context.riskClass,
    conformance: context.conformance,
    evalResults: context.evalResults,
    candidateRef: context.candidateRef,
    provenanceRef: context.provenanceRef,
    ts,
    tenant: rebuilt.tenant,
  };
}

function validateEvent(current, streamId) {
  expectObject(current, "$.event");
  assertNonEmptyString(current.type, "$.event.type");
  if (current.v !== 1) {
    throw new PromotionGateContractError("promotion.event_version", "$.event.v");
  }
  if (current.streamId !== streamId) {
    throw new PromotionGateContractError("promotion.stream_mismatch", "$.event.streamId");
  }
  if (!Number.isInteger(current.seq) || current.seq <= 0) {
    throw new PromotionGateContractError("promotion.event_seq", "$.event.seq");
  }
  assertIsoTimestamp(current.ts, "$.event.ts");
  assertNonEmptyString(current.correlationId, "$.event.correlationId");
  expectObject(current.data, "$.event.data");
}

function nextSeq(events) {
  return Math.max(...events.map((current) => current.seq)) + 1;
}

function assertIsoTimestamp(input, path) {
  const value = assertNonEmptyString(input, path);
  if (Number.isNaN(Date.parse(value))) {
    throw new PromotionGateContractError("promotion.timestamp", path);
  }
  return value;
}

function parseStringArray(input, path) {
  if (!Array.isArray(input)) {
    throw new PromotionGateContractError("promotion.expected_array", path);
  }
  return input.map((item, index) => assertNonEmptyString(item, `${path}[${index}]`));
}

function expectObject(input, path) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new PromotionGateContractError("promotion.expected_object", path);
  }
  return input;
}

function assertNonEmptyString(input, path) {
  if (!isJsonString(input) || input.trim() === "") {
    throw new PromotionGateContractError("promotion.expected_string", path);
  }
  return input;
}

function hashJson(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value) {
  if (value === null || !isJsonObject(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}
