import { isJsonString, isJsonBoolean, isJsonObject } from "./json.js";
export const REMEDIATION_ACTION_EVENT_TYPE = "crew.ActionProposed";

export const remediationActionKinds = Object.freeze({
  failover: "failover",
  scale: "scale",
  retry: "retry",
  circuitBreak: "circuit-break",
  resync: "resync",
  compensate: "compensate",
  deadLetter: "dead-letter",
  revertChampion: "revert-champion",
  rotateCredential: "rotate-credential",
  haltSpend: "halt-spend",
  degrade: "degrade",
  escalate: "escalate",
  propose: "propose",
});

export const knownRemediationActionKinds = Object.freeze(Object.values(remediationActionKinds));

const knownRemediationActionKindSet = new Set(knownRemediationActionKinds);

export const remediationEffectClasses = Object.freeze({
  auto: "auto",
  canaryWithAutoRollback: "canary-with-auto-rollback",
  requireApproval: "require-approval",
});

const knownTargets = new Set(["resource", "camp", "region"]);
const knownScopes = new Set(["resource", "camp", "region"]);
const knownImpacts = new Set(["low", "medium", "high"]);
const knownConformanceStates = new Set(["green", "unknown", "failing"]);
const prodNames = new Set(["prod", "production"]);
const knownNonProdNames = new Set([
  "dev",
  "development",
  "ephemeral",
  "local",
  "preview",
  "stage",
  "staging",
  "test",
  "testing",
]);

export function validateRemediationAction(candidate) {
  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    throw new TypeError("RemediationAction must be an object");
  }

  const action = {
    kind: requireNonEmptyString(candidate.kind, "kind"),
    target: validateTarget(candidate.target),
    blastRadius: validateBlastRadius(candidate.blastRadius),
    environment:
      candidate.environment === undefined
        ? "unknown"
        : requireNonEmptyString(candidate.environment, "environment").toLowerCase(),
    idempotencyKey: requireNonEmptyString(candidate.idempotencyKey, "idempotencyKey"),
    conformanceState:
      candidate.conformanceState === undefined
        ? "unknown"
        : requireKnownString(candidate.conformanceState, "conformanceState", knownConformanceStates),
  };

  return Object.freeze(action);
}

export function classifyRemediationEffect(action) {
  const validated = validateRemediationAction(action);

  if (!knownRemediationActionKindSet.has(validated.kind)) {
    return decision("require-approval", "unknown-kind-fail-closed");
  }

  if (validated.environment === "unknown") {
    return decision("require-approval", "unknown-environment-fail-closed");
  }

  if (prodNames.has(validated.environment)) {
    return decision("require-approval", "production-requires-approval");
  }

  if (!knownNonProdNames.has(validated.environment)) {
    return decision("require-approval", "unrecognized-environment-fail-closed");
  }

  if (!validated.blastRadius.reversible) {
    return decision("require-approval", "irreversible-action-requires-approval");
  }

  if (validated.conformanceState !== "green") {
    return decision("require-approval", "conformance-not-green");
  }

  if (validated.blastRadius.estimatedImpact === "low") {
    return decision("auto", "low-risk-reversible-non-prod");
  }

  if (validated.blastRadius.estimatedImpact === "medium") {
    return decision("canary-with-auto-rollback", "medium-risk-reversible-non-prod");
  }

  return decision("require-approval", "high-impact-requires-approval");
}

export function makeRemediationActionEvent({ id, incidentId, action, decision: rawDecision }) {
  const validatedAction = validateRemediationAction(action);
  const policyDecision = rawDecision ?? classifyRemediationEffect(validatedAction);

  return Object.freeze({
    id: requireNonEmptyString(id, "id"),
    type: REMEDIATION_ACTION_EVENT_TYPE,
    payload: Object.freeze({
      incidentId: requireNonEmptyString(incidentId, "incidentId"),
      action: validatedAction,
      blastRadius: validatedAction.blastRadius,
      policyEffectClass: policyDecision.effectClass,
      policyReason: policyDecision.reason,
    }),
  });
}

function validateTarget(target) {
  if (!target || !isJsonObject(target) || Array.isArray(target)) {
    throw new TypeError("target is required");
  }

  return Object.freeze({
    kind: requireKnownString(target.kind, "target.kind", knownTargets),
    id: requireNonEmptyString(target.id, "target.id"),
  });
}

function validateBlastRadius(blastRadius) {
  if (!blastRadius || !isJsonObject(blastRadius) || Array.isArray(blastRadius)) {
    throw new TypeError("blastRadius is required");
  }

  const reversible = requireBoolean(blastRadius.reversible, "blastRadius.reversible");

  if (reversible && !isNonEmptyString(blastRadius.compensationPath)) {
    throw new TypeError("blastRadius.compensationPath is required for reversible actions");
  }

  const normalized = {
    scope: requireKnownString(blastRadius.scope, "blastRadius.scope", knownScopes),
    reversible,
    estimatedImpact: requireKnownString(
      blastRadius.estimatedImpact,
      "blastRadius.estimatedImpact",
      knownImpacts,
    ),
  };

  if (isNonEmptyString(blastRadius.compensationPath)) {
    normalized.compensationPath = blastRadius.compensationPath;
  }

  return Object.freeze(normalized);
}

function decision(effectClass, reason) {
  return Object.freeze({ effectClass, reason });
}

function requireKnownString(value, name, allowed) {
  const text = requireNonEmptyString(value, name);

  if (!allowed.has(text)) {
    throw new TypeError(`${name} must be one of: ${[...allowed].join(", ")}`);
  }

  return text;
}

function requireNonEmptyString(value, name) {
  if (!isNonEmptyString(value)) {
    throw new TypeError(`${name} must be a non-empty string`);
  }

  return value.trim();
}

function requireBoolean(value, name) {
  if (!isJsonBoolean(value)) {
    throw new TypeError(`${name} must be a boolean`);
  }

  return value;
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}
