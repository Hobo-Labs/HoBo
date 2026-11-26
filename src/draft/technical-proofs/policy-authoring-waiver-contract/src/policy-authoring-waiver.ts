import {
  buildControlPlaneActionId,
} from "../../control-plane-action-taxonomy-contract/src/control-plane-action-taxonomy.js";
import {
  composePolicyPacks,
  definePolicyPack,
} from "../../deny-ceiling-algebra-poc/src/deny-ceiling-algebra.js";
import { isJsonString, isJsonObject } from "./json.js";


export const POLICY_AUTHORING_SCHEMA_VERSION = "hobo.policy-authoring/v1";
export const POLICY_WAIVER_SCHEMA_VERSION = "hobo.policy-waiver/v1";
export const POLICY_WAIVER_REQUESTED = "policy.WaiverRequested";
export const POLICY_WAIVER_APPROVED = "policy.WaiverApproved";

export const REQUIRED_POLICY_PACK_ACTIONS = Object.freeze([
  buildControlPlaneActionId("policy-pack", "create"),
  buildControlPlaneActionId("policy-pack", "update"),
  buildControlPlaneActionId("policy-pack", "approve"),
]);

const POLICY_RULE_AUTHORING = "typed-typescript-policy-rule";
const SCOPE_SET = new Set(["junction", "yard", "camp", "bindle"]);
const MODE_SET = new Set(["mandatory", "default"]);
const EFFECT_SET = new Set(["deny", "allow"]);
const OPERATION_SET = new Set(["create", "update"]);
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function definePolicyRule({ id, mode = "mandatory", effect = "deny", target, reason }) {
  const parsedMode = expectOneOf(mode, MODE_SET, "mode");
  const parsedEffect = expectOneOf(effect, EFFECT_SET, "effect");
  if (parsedMode === "mandatory" && parsedEffect === "allow") {
    throw new Error("mandatory policy rules cannot grant allow effects");
  }

  return {
    authoring: POLICY_RULE_AUTHORING,
    id: expectNonEmptyString(id, "id"),
    mode: parsedMode,
    effect: parsedEffect,
    target: normalizeTarget(target),
    reason: expectNonEmptyString(reason, "reason"),
  };
}

export function compilePolicyPack({ id, scope, version, author, rules }) {
  const packId = expectNonEmptyString(id, "id");
  const parsedScope = expectOneOf(scope, SCOPE_SET, "scope");
  const parsedVersion = expectSemver(version, "version");
  const parsedAuthor = normalizePrincipal(author);
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error("rules must be a non-empty array");
  }

  return {
    ...definePolicyPack({
      id: packId,
      scope: parsedScope,
      rules: rules.map(compileRule),
    }),
    schemaVersion: POLICY_AUTHORING_SCHEMA_VERSION,
    version: parsedVersion,
    authoredBy: parsedAuthor,
    requiredControlPlaneActions: [...REQUIRED_POLICY_PACK_ACTIONS],
  };
}

export function proposePolicyPackChange({ operation, pack, author, approverRole }) {
  const parsedOperation = expectOneOf(operation, OPERATION_SET, "operation");
  const parsedAuthor = normalizePrincipal(author);
  const role = expectNonEmptyString(approverRole, "approverRole");
  const actionId = buildControlPlaneActionId("policy-pack", parsedOperation);

  return {
    schemaVersion: POLICY_AUTHORING_SCHEMA_VERSION,
    id: `policy-pack-change:${expectNonEmptyString(pack?.id, "pack.id")}:${expectNonEmptyString(pack?.version, "pack.version")}:${parsedOperation}`,
    status: "pending-approval",
    operation: parsedOperation,
    pack,
    author: parsedAuthor,
    approverRole: role,
    controlPlaneActions: [
      actionId,
      buildControlPlaneActionId("policy-pack", "approve"),
    ],
  };
}

export function approvePolicyPackChange({ change, approver, now = new Date() }) {
  const parsedChange = expectObject(change, "change");
  const parsedApprover = normalizePrincipal(approver);
  if (samePrincipal(parsedChange.author, parsedApprover)) {
    return denied("separation-of-duties", "policy pack author cannot approve their own change");
  }
  if (!hasRole(parsedApprover, parsedChange.approverRole)) {
    return denied(
      "missing-approver-role",
      `approver lacks required role ${parsedChange.approverRole}`,
    );
  }

  return {
    ok: true,
    change: {
      ...parsedChange,
      status: "approved",
      approvedBy: parsedApprover,
      approvedAt: toIsoDate(now, "now"),
    },
  };
}

export function requestPolicyWaiver({
  requester,
  target,
  policyPacks,
  approverRole,
  reason,
  now = new Date(),
  expiresAt,
}) {
  const parsedRequester = normalizePrincipal(requester);
  const parsedTarget = normalizeTarget(target);
  const requestedAt = toIsoDate(now, "now");
  const parsedExpiresAt = toIsoDate(expiresAt, "expiresAt");
  const parsedReason = expectNonEmptyString(reason, "reason");

  if (!hasAction(parsedRequester, parsedTarget.actionId)) {
    return denied(
      "deny-by-default",
      `requester lacks ${parsedTarget.actionId}; waiver cannot create base access`,
    );
  }
  if (!isNonEmptyString(approverRole)) {
    return denied("missing-approver-role", "waiver requests require a configured approver role");
  }
  if (Date.parse(parsedExpiresAt) <= Date.parse(requestedAt)) {
    return denied("invalid-expiration", "waiver expiresAt must be after request time");
  }

  const denial = findMatchingPolicyDeny(policyPacks, parsedTarget);
  if (!denial.ok) {
    return denial;
  }
  if (denial.entry.mode === "mandatory") {
    return denied(
      "mandatory-deny-ceiling",
      `mandatory deny-ceiling ${parsedTarget.tuple} cannot be waived`,
    );
  }

  const waiver = {
    schemaVersion: POLICY_WAIVER_SCHEMA_VERSION,
    id: waiverId(parsedTarget, parsedRequester, requestedAt),
    status: "requested",
    target: parsedTarget,
    requester: parsedRequester,
    approverRole: approverRole.trim(),
    reason: parsedReason,
    requestedAt,
    expiresAt: parsedExpiresAt,
    sourcePolicyIds: [...denial.entry.sources],
    audit: [],
  };
  const event = createWaiverEvent(POLICY_WAIVER_REQUESTED, waiver, parsedRequester, requestedAt);
  const auditedWaiver = {
    ...waiver,
    audit: [event],
  };

  return { ok: true, waiver: auditedWaiver, events: auditedWaiver.audit };
}

export function approvePolicyWaiver({ waiver, approver, now = new Date() }) {
  const parsedWaiver = expectObject(waiver, "waiver");
  const parsedApprover = normalizePrincipal(approver);
  const approvedAt = toIsoDate(now, "now");
  if (parsedWaiver.status !== "requested") {
    return denied("invalid-waiver-status", "only requested waivers can be approved");
  }
  if (samePrincipal(parsedWaiver.requester, parsedApprover)) {
    return denied("separation-of-duties", "waiver requester cannot approve their own waiver");
  }
  if (!hasRole(parsedApprover, parsedWaiver.approverRole)) {
    return denied(
      "missing-approver-role",
      `approver lacks required role ${parsedWaiver.approverRole}`,
    );
  }
  if (Date.parse(parsedWaiver.expiresAt) <= Date.parse(approvedAt)) {
    return denied("waiver-expired", "waiver expired before approval");
  }

  const approvedWaiver = {
    ...parsedWaiver,
    status: "approved",
    approvedBy: parsedApprover,
    approvedAt,
  };
  const event = createWaiverEvent(POLICY_WAIVER_APPROVED, approvedWaiver, parsedApprover, approvedAt);
  const audit = [...(Array.isArray(parsedWaiver.audit) ? parsedWaiver.audit : []), event];

  return {
    ok: true,
    waiver: {
      ...approvedWaiver,
      audit,
    },
    events: audit,
  };
}

export function evaluatePolicyWaiver({ target, waiver, policyPacks, now = new Date() }) {
  const parsedTarget = normalizeTarget(target);
  const evaluatedAt = toIsoDate(now, "now");
  const denial = findMatchingPolicyDeny(policyPacks, parsedTarget);
  if (!denial.ok) {
    return denyDecision(denial.reason, parsedTarget, { code: denial.code });
  }
  if (denial.entry.mode === "mandatory") {
    return denyDecision(
      `mandatory deny-ceiling ${parsedTarget.tuple} cannot be waived`,
      parsedTarget,
      { code: "mandatory-deny-ceiling" },
    );
  }

  if (!waiver || waiver.status !== "approved") {
    return denyDecision("no approved waiver grants this default policy exception", parsedTarget, {
      code: "missing-approved-waiver",
    });
  }
  if (!sameTarget(parsedTarget, waiver.target)) {
    return denyDecision("waiver scope mismatch", parsedTarget, {
      code: "scope-mismatch",
      waiverId: waiver.id,
    });
  }
  if (Date.parse(waiver.expiresAt) <= Date.parse(evaluatedAt)) {
    return denyDecision("waiver expired", parsedTarget, {
      code: "waiver-expired",
      waiverId: waiver.id,
      expiresAt: waiver.expiresAt,
    });
  }

  return {
    effect: "allow",
    reason: "approved waiver permits default policy exception",
    target: parsedTarget,
    evidence: {
      waiverId: waiver.id,
      sourcePolicyIds: [...denial.entry.sources],
      expiresAt: waiver.expiresAt,
      auditEventTypes: (waiver.audit ?? []).map((event) => event.type),
    },
  };
}

function compileRule(ruleInput) {
  const rule = ruleInput?.authoring === POLICY_RULE_AUTHORING
    ? ruleInput
    : definePolicyRule(ruleInput);
  const target = normalizeTarget(rule.target);

  return {
    id: expectNonEmptyString(rule.id, "rule.id"),
    mode: expectOneOf(rule.mode, MODE_SET, "rule.mode"),
    denies: rule.effect === "deny" ? [target.tuple] : [],
    allows: rule.effect === "allow" ? [target.tuple] : [],
    limits: [],
    reason: expectNonEmptyString(rule.reason, "rule.reason"),
    target,
  };
}

function findMatchingPolicyDeny(policyPacks, target) {
  const composition = composePolicyPacks(policyPacks);
  if (!composition.ok) {
    return denied(
      "policy-composition-invalid",
      [...composition.errors, ...composition.violations].join("; "),
    );
  }
  const entry = composition.effectiveDenySet.find((candidate) => candidate.tuple === target.tuple);
  if (!entry) {
    return denied("no-policy-deny", `no policy deny matched ${target.tuple}`);
  }
  return { ok: true, entry };
}

function normalizeTarget(target) {
  const input = expectObject(target, "target");
  const resource = stripHoboPrefix(
    input.resource ?? input.resourceName ?? input.resourceKind,
    "target.resource",
  );
  const verb = expectNonEmptyString(input.verb ?? input.action, "target.verb");
  const phase = expectNonEmptyString(input.phase, "target.phase");
  const actionId = buildControlPlaneActionId(resource, verb);
  const resourceId = expectNonEmptyString(input.resourceId ?? `${resource}:*`, "target.resourceId");
  const resourceKind = `hobo:${resource}`;

  return {
    resource,
    resourceKind,
    resourceId,
    verb,
    phase,
    actionId,
    tuple: `${resourceKind}:${verb}:${phase}`,
  };
}

function normalizePrincipal(principal) {
  const input = expectObject(principal, "principal");
  return {
    kind: expectNonEmptyString(input.kind, "principal.kind"),
    id: expectNonEmptyString(input.id, "principal.id"),
    roles: normalizeStringArray(input.roles ?? [], "principal.roles"),
    allowedActionIds: normalizeStringArray(input.allowedActionIds ?? [], "principal.allowedActionIds"),
  };
}

function createWaiverEvent(type, waiver, actor, occurredAt) {
  return {
    type,
    schemaVersion: POLICY_WAIVER_SCHEMA_VERSION,
    occurredAt,
    actor: {
      kind: actor.kind,
      id: actor.id,
      roles: [...actor.roles],
    },
    data: {
      waiverId: waiver.id,
      status: waiver.status,
      target: waiver.target,
      requester: waiver.requester,
      approverRole: waiver.approverRole,
      reason: waiver.reason,
      requestedAt: waiver.requestedAt,
      approvedAt: waiver.approvedAt,
      expiresAt: waiver.expiresAt,
      sourcePolicyIds: [...waiver.sourcePolicyIds],
    },
  };
}

function sameTarget(left, rightInput) {
  const right = normalizeTarget(rightInput);
  return (
    left.resource === right.resource &&
    left.resourceKind === right.resourceKind &&
    left.resourceId === right.resourceId &&
    left.verb === right.verb &&
    left.phase === right.phase &&
    left.actionId === right.actionId &&
    left.tuple === right.tuple
  );
}

function samePrincipal(left, right) {
  return left?.kind === right?.kind && left?.id === right?.id;
}

function hasRole(principal, role) {
  return principal.roles.includes(role);
}

function hasAction(principal, actionId) {
  return principal.allowedActionIds.includes(actionId);
}

function waiverId(target, requester, requestedAt) {
  return `policy-waiver:${target.actionId}:${target.resourceId}:${requester.id}:${requestedAt}`
    .replaceAll(/[^a-zA-Z0-9:._-]/g, "-");
}

function denied(code, reason) {
  return { ok: false, code, reason };
}

function denyDecision(reason, target, evidence = {}) {
  return {
    effect: "deny",
    reason,
    target,
    evidence,
  };
}

function expectObject(value, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function expectNonEmptyString(value, path) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function expectSemver(value, path) {
  const parsed = expectNonEmptyString(value, path);
  if (!SEMVER_RE.test(parsed)) {
    throw new Error(`${path} must be semver`);
  }
  return parsed;
}

function expectOneOf(value, allowed, path) {
  const parsed = expectNonEmptyString(value, path);
  if (!allowed.has(parsed)) {
    throw new Error(`${path} must be one of ${[...allowed].join(", ")}`);
  }
  return parsed;
}

function normalizeStringArray(value, path) {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value.map((item, index) => expectNonEmptyString(item, `${path}[${index}]`));
}

function stripHoboPrefix(value, path) {
  const parsed = expectNonEmptyString(value, path);
  return parsed.startsWith("hobo:") ? parsed.slice("hobo:".length) : parsed;
}

function toIsoDate(value, path) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${path} must be a valid date`);
  }
  return date.toISOString();
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}
