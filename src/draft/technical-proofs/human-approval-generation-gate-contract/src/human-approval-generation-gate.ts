import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const HUMAN_APPROVAL_GATE_SCHEMA = "hobo.gen.human-approval-gate/v1";

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const KNOWN_RISK_CLASSES = new Set(["low", "medium", "high"]);
const PRODUCTION_ENVS = new Set(["prod", "production"]);
const REQUIRED_REPORT_REFS = Object.freeze(["provenance", "conformance", "safetyReport"]);

export class HumanApprovalGateError extends Error {
  constructor(code, path = "$", message = code) {
    super(`${code} at ${path}: ${message}`);
    this.name = "HumanApprovalGateError";
    this.code = code;
    this.path = path;
  }
}

export function decideGenerationHumanApproval(requestInput) {
  const request = parseGenerationRequest(requestInput);
  const policyIds = policyPackIds(request.policyPacks);
  const requirement = classifyApprovalRequirement(request);
  const decision = createPolicyDecision(request, requirement, policyIds);
  const events = [
    event(request, 1, "policy.Decided", decision),
  ];

  if (!requirement.required) {
    const certification = createCertifiedData(request, decision);
    events.push(event(request, 2, "gen.Certified", certification));
    return {
      status: "certified",
      certified: true,
      decision,
      approvalHook: null,
      events,
    };
  }

  const approvalHook = createApprovalHook(request, decision);
  events.push(
    event(request, 2, "policy.ObligationCreated", {
      id: approvalHook.id,
      kind: "createHook",
      status: "open",
      reason: decision.reason,
      policyDecisionInputHash: decision.evidence.inputHash,
      reportRefs: approvalHook.reportRefs,
    }),
    event(request, 3, "gen.ApprovalHookCreated", approvalHook),
  );

  return {
    status: "approval-required",
    certified: false,
    decision,
    approvalHook,
    events,
  };
}

export function resolveGenerationHumanApproval(eventsInput, approvalInput) {
  const state = replayHumanApprovalGate(eventsInput);
  if (!state.approvalHook) {
    throw new HumanApprovalGateError("approval.hook_missing", "$.events");
  }
  const approval = parseApprovalDecision(approvalInput, state);
  const request = state.request;
  const baseSeq = nextSeq(eventsInput);
  const recorded = event(request, baseSeq, "gen.ApprovalDecisionRecorded", approval);
  const events = [recorded];

  if (approval.resolution !== "approved") {
    return {
      status: "denied",
      certified: false,
      events,
    };
  }

  events.push(event({ ...request, ts: approval.ts }, baseSeq + 1, "gen.Certified", {
    ...createCertifiedData(request, state.policyDecision.data),
    approvedBy: approval.approvedBy,
    approvalEventId: recorded.id,
  }));

  return {
    status: "certified",
    certified: true,
    events,
  };
}

export function replayHumanApprovalGate(eventsInput) {
  if (!Array.isArray(eventsInput) || eventsInput.length === 0) {
    throw new HumanApprovalGateError("events.required", "$.events");
  }

  const events = [...eventsInput].sort((left, right) => left.seq - right.seq);
  const streamId = nonEmptyString(events[0].streamId, "$.events[0].streamId");
  const state = {
    streamId,
    request: null,
    policyDecision: null,
    approvalHook: null,
    approval: null,
    certification: null,
    certified: false,
  };

  for (const current of events) {
    validateEvent(current, streamId);
    if (current.type === "policy.Decided") {
      state.policyDecision = current;
      state.request = current.data.context.request;
    } else if (current.type === "gen.ApprovalHookCreated") {
      state.approvalHook = current.data;
    } else if (current.type === "gen.ApprovalDecisionRecorded") {
      state.approval = current.data;
    } else if (current.type === "gen.Certified") {
      state.certification = current.data;
      state.certified = true;
    } else if (current.type !== "policy.ObligationCreated") {
      throw new HumanApprovalGateError("events.unknown_type", "$.events[].type");
    }
  }

  return state;
}

function parseGenerationRequest(input) {
  const request = object(input, "$");
  const target = object(request.target, "$.target");
  const evidence = object(request.evidence, "$.evidence");
  const reports = object(request.reports, "$.reports");
  const parsed = {
    requestId: nonEmptyString(request.requestId, "$.requestId"),
    subject: parseSubject(request.subject, "$.subject"),
    action: nonEmptyString(request.action, "$.action"),
    environment: nonEmptyString(request.environment, "$.environment"),
    requestedRiskClass: nonEmptyString(request.requestedRiskClass, "$.requestedRiskClass"),
    target: {
      kind: nonEmptyString(target.kind, "$.target.kind"),
      id: nonEmptyString(target.id, "$.target.id"),
      trustClass: target.trustClass ?? "normal",
      destructive: target.destructive === true,
    },
    evidence: {
      actualRiskClass: evidence.actualRiskClass ?? request.requestedRiskClass,
      riskReasons: Array.isArray(evidence.riskReasons) ? stringArray(evidence.riskReasons, "$.evidence.riskReasons") : [],
    },
    reports: Object.fromEntries(
      REQUIRED_REPORT_REFS.map((key) => [key, parseReportRef(reports[key], `$.reports.${key}`)]),
    ),
    policyPacks: Array.isArray(request.policyPacks) ? request.policyPacks.map(parsePolicyPack) : [],
    ts: isoTimestamp(request.ts, "$.ts"),
  };
  parsed.riskClass = computedRiskClass(parsed);
  parsed.tuple = `${parsed.action}:${parsed.environment}`;
  return parsed;
}

function parseSubject(input, path) {
  const subject = object(input, path);
  return {
    kind: nonEmptyString(subject.kind, `${path}.kind`),
    id: nonEmptyString(subject.id, `${path}.id`),
  };
}

function parseReportRef(input, path) {
  const ref = object(input, path);
  const digest = nonEmptyString(ref.digest, `${path}.digest`);
  if (!DIGEST_RE.test(digest)) {
    throw new HumanApprovalGateError("report.digest", `${path}.digest`);
  }
  return {
    uri: nonEmptyString(ref.uri, `${path}.uri`),
    digest,
  };
}

function parsePolicyPack(input, index) {
  const path = `$.policyPacks[${index}]`;
  const pack = object(input, path);
  return {
    id: nonEmptyString(pack.id, `${path}.id`),
    scope: nonEmptyString(pack.scope, `${path}.scope`),
    mode: pack.mode === "mandatory" ? "mandatory" : "default",
    requireHumanApprovalFor: Array.isArray(pack.requireHumanApprovalFor)
      ? stringArray(pack.requireHumanApprovalFor, `${path}.requireHumanApprovalFor`)
      : [],
    autoApproveFor: Array.isArray(pack.autoApproveFor)
      ? stringArray(pack.autoApproveFor, `${path}.autoApproveFor`)
      : [],
  };
}

function classifyApprovalRequirement(request) {
  const mandatoryPacks = request.policyPacks.filter(
    (pack) => pack.mode === "mandatory" && pack.requireHumanApprovalFor.includes(request.tuple),
  );
  if (mandatoryPacks.length > 0) {
    return {
      required: true,
      reason: `mandatory deny-ceiling requires human approval for ${request.tuple}`,
    };
  }
  if (!KNOWN_RISK_CLASSES.has(request.riskClass)) {
    return {
      required: true,
      reason: `unknown risk defaults to human approval: ${request.evidence.actualRiskClass}`,
    };
  }
  if (request.riskClass === "high") {
    return {
      required: true,
      reason:
        request.requestedRiskClass === "low"
          ? "computed high-risk overrides caller risk downgrade"
          : "high-risk generation requires human approval",
    };
  }
  if (PRODUCTION_ENVS.has(request.environment)) {
    return {
      required: true,
      reason: "prod generation requires human approval",
    };
  }
  if (request.target.trustClass === "high-trust") {
    return {
      required: true,
      reason: "high-trust generation requires human approval",
    };
  }
  if (request.target.destructive) {
    return {
      required: true,
      reason: "destructive generation requires human approval",
    };
  }
  return {
    required: false,
    reason: "low-risk preview generation may certify without approval",
  };
}

function computedRiskClass(request) {
  const actual = request.evidence.actualRiskClass;
  if (!KNOWN_RISK_CLASSES.has(actual)) {
    return "unknown";
  }
  if (actual === "high") {
    return "high";
  }
  if (request.target.destructive || request.target.trustClass === "high-trust") {
    return "high";
  }
  return actual;
}

function createPolicyDecision(request, requirement, policyIds) {
  const decision = {
    effect: requirement.required ? "require-approval" : "allow",
    reason: requirement.reason,
    context: {
      request: clone({
        requestId: request.requestId,
        subject: request.subject,
        action: request.action,
        environment: request.environment,
        target: request.target,
        reports: request.reports,
      }),
      riskClass: request.riskClass,
      requestedRiskClass: request.requestedRiskClass,
      riskReasons: request.evidence.riskReasons,
    },
    approvals: requirement.required
      ? [{
          kind: "human-approval",
          hookId: hookId(request),
          requiredReports: [...REQUIRED_REPORT_REFS],
        }]
      : [],
    obligations: requirement.required
      ? [{
          kind: "createHook",
          id: hookId(request),
          deadline: "PT30M",
        }]
      : [],
    evidence: {
      engine: "hobo.gen-human-approval-gate/poc",
      inputHash: hashJson({
        requestId: request.requestId,
        subject: request.subject,
        action: request.action,
        environment: request.environment,
        target: request.target,
        riskClass: request.riskClass,
        reports: request.reports,
      }),
      policyIds,
    },
  };
  return decision;
}

function createApprovalHook(request, decision) {
  return {
    kind: "createHook",
    id: hookId(request),
    requestId: request.requestId,
    reason: decision.reason,
    reportRefs: clone(request.reports),
    requiredReports: [...REQUIRED_REPORT_REFS],
    deadline: "PT30M",
  };
}

function parseApprovalDecision(input, state) {
  const approval = object(input, "$.approval");
  const hookIdValue = nonEmptyString(approval.hookId, "$.approval.hookId");
  if (hookIdValue !== state.approvalHook.id) {
    throw new HumanApprovalGateError("approval.hook_mismatch", "$.approval.hookId");
  }
  const actor = parseSubject(approval.actor, "$.approval.actor");
  if (actor.kind !== "user") {
    throw new HumanApprovalGateError("approval.actor_not_human", "$.approval.actor.kind");
  }
  if (actor.id === state.request.subject.id) {
    throw new HumanApprovalGateError("approval.self_approval_denied", "$.approval.actor.id");
  }
  if (approval.autoResolved === true || !isJsonString(approval.humanSignal) || approval.humanSignal.trim() === "") {
    throw new HumanApprovalGateError("approval.meaningful_signal_required", "$.approval.humanSignal");
  }
  const reportRefsShown = stringArray(approval.reportRefsShown, "$.approval.reportRefsShown");
  for (const required of REQUIRED_REPORT_REFS) {
    if (!reportRefsShown.includes(required)) {
      throw new HumanApprovalGateError("approval.report_not_shown", "$.approval.reportRefsShown");
    }
  }
  const resolution = nonEmptyString(approval.resolution, "$.approval.resolution");
  if (!["approved", "denied"].includes(resolution)) {
    throw new HumanApprovalGateError("approval.resolution", "$.approval.resolution");
  }
  return {
    hookId: hookIdValue,
    resolution,
    approvedBy: nonEmptyString(approval.approvedBy, "$.approval.approvedBy"),
    actor,
    humanSignal: approval.humanSignal,
    reportRefsShown,
    reason: approval.reason ?? resolution,
    ts: isoTimestamp(approval.ts, "$.approval.ts"),
  };
}

function createCertifiedData(request, decision) {
  return {
    requestId: request.requestId,
    candidateRef: request.reports.provenance,
    provenanceRef: request.reports.provenance,
    conformanceReportRef: request.reports.conformance,
    safetyReportRef: request.reports.safetyReport,
    gateDecision: {
      effect: "certify",
      reason: decision.reason,
      policyInputHash: decision.evidence.inputHash,
      policyIds: decision.evidence.policyIds,
    },
  };
}

function event(request, seq, type, data) {
  const ts = type === "gen.ApprovalDecisionRecorded" ? data.ts : request.ts;
  return {
    id: `${request.requestId}:${seq}:${type}`,
    type,
    v: 1,
    schema: HUMAN_APPROVAL_GATE_SCHEMA,
    streamId: `generation-human-approval:${request.requestId}`,
    seq,
    ts,
    actor: type === "gen.ApprovalDecisionRecorded" ? data.actor : request.subject,
    correlationId: request.requestId,
    data,
  };
}

function validateEvent(current, streamId) {
  object(current, "$.event");
  nonEmptyString(current.type, "$.event.type");
  if (current.v !== 1) {
    throw new HumanApprovalGateError("events.version", "$.event.v");
  }
  if (current.streamId !== streamId) {
    throw new HumanApprovalGateError("events.stream_mismatch", "$.event.streamId");
  }
  if (!Number.isInteger(current.seq) || current.seq <= 0) {
    throw new HumanApprovalGateError("events.seq", "$.event.seq");
  }
  isoTimestamp(current.ts, "$.event.ts");
  object(current.data, "$.event.data");
}

function nextSeq(events) {
  return Math.max(...events.map((current) => current.seq)) + 1;
}

function hookId(request) {
  return `hook:${request.requestId}:human-approval`;
}

function policyPackIds(packs) {
  return packs.map((pack) => pack.id);
}

function stringArray(input, path) {
  if (!Array.isArray(input)) {
    throw new HumanApprovalGateError("expected_array", path);
  }
  return input.map((value, index) => nonEmptyString(value, `${path}[${index}]`));
}

function object(input, path) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new HumanApprovalGateError("expected_object", path);
  }
  return input;
}

function nonEmptyString(input, path) {
  if (!isJsonString(input) || input.trim() === "") {
    throw new HumanApprovalGateError("expected_string", path);
  }
  return input;
}

function isoTimestamp(input, path) {
  const value = nonEmptyString(input, path);
  if (Number.isNaN(Date.parse(value))) {
    throw new HumanApprovalGateError("expected_iso_timestamp", path);
  }
  return value;
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
