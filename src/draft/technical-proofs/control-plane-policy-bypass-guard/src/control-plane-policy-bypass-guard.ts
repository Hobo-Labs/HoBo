import {
  CONTROL_PLANE_ACTIONS,
  checkControlPlaneCompleteness,
  highPrivilegeActionIds,
} from "../../control-plane-action-taxonomy-contract/src/control-plane-action-taxonomy.js";
import {
  evaluateAndRecordPolicyDecision,
} from "../../built-in-policy-engine-contract/src/built-in-policy-engine.js";
import {
  POLICY_IR_SCHEMA_VERSION,
  createDecisionRequest,
} from "../../hobo-policy-ir-contract/src/policy-ir.js";
import { isJsonString } from "./json.js";


const REQUIRED_HIGH_PRIVILEGE_ACTIONS = Object.freeze([
  "hobo:derivative:upgrade",
  "hobo:registry:import",
  "hobo:relay:attach",
  "hobo:relay:register",
]);

export function checkControlPlaneBuildGate({
  taxonomy = CONTROL_PLANE_ACTIONS,
  routes = [],
} = {}) {
  const mappedActionIds = [];
  const missingMappings = [];

  for (const route of routes) {
    if (!isNonEmptyString(route?.actionId)) {
      missingMappings.push(missing(route, "missing action id"));
      continue;
    }
    if (!isNonEmptyString(route?.resource) || !isNonEmptyString(route?.verb)) {
      missingMappings.push(missing(route, "missing resource or verb"));
      continue;
    }

    const completeness = checkControlPlaneCompleteness({
      taxonomy,
      controlPlaneVerbs: [route],
    });
    if (!completeness.ok) {
      missingMappings.push(missing(route, completeness.missingMappings[0].reason));
      continue;
    }

    const expectedActionId = completeness.mappedActionIds[0];
    if (route.actionId !== expectedActionId) {
      missingMappings.push(
        missing(route, `action id mismatch: expected ${expectedActionId}, got ${route.actionId}`),
      );
      continue;
    }

    mappedActionIds.push(route.actionId);
  }

  return {
    ok: missingMappings.length === 0,
    mappedActionIds,
    missingMappings,
  };
}

export function buildControlPlanePolicyRequest({
  operation,
  taxonomy = CONTROL_PLANE_ACTIONS,
} = {}) {
  const completeness = checkControlPlaneBuildGate({
    taxonomy,
    routes: [operation],
  });
  if (!completeness.ok) {
    throw new Error(`control-plane action is not policy-mapped: ${completeness.missingMappings[0].reason}`);
  }

  return createDecisionRequest({
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: operation.subject,
    action: operation.verb,
    resource: {
      kind: `hobo:${operation.resource}`,
      id: operation.resourceId ?? operation.actionId,
    },
    phase: operation.phase,
    context: {
      ...(operation.context),
      actionId: operation.actionId,
      command: operation.command,
      surface: operation.surface,
    },
  });
}

export async function guardControlPlaneSideEffect({
  operation,
  taxonomy = CONTROL_PLANE_ACTIONS,
  engine,
  ruleset,
  auditSink,
  sideEffect,
} = {}) {
  if (!(sideEffect instanceof Function)) {
    throw new TypeError("sideEffect must be a function");
  }

  const completeness = checkControlPlaneBuildGate({
    taxonomy,
    routes: [operation],
  });
  if (!completeness.ok) {
    return {
      allowed: false,
      sideEffectRan: false,
      completeness,
      request: null,
      decision: null,
    };
  }

  const request = buildControlPlanePolicyRequest({ operation, taxonomy });
  const decision = await evaluateAndRecordPolicyDecision({
    engine,
    request,
    ruleset,
    auditSink,
  });

  if (decision.effect !== "allow") {
    return {
      allowed: false,
      sideEffectRan: false,
      completeness,
      request,
      decision,
    };
  }

  const sideEffectResult = await sideEffect({ operation, request, decision });

  return {
    allowed: true,
    sideEffectRan: true,
    completeness,
    request,
    decision,
    sideEffectResult,
  };
}

export function assertHighPrivilegeActionsEnumerated({
  taxonomy = CONTROL_PLANE_ACTIONS,
  requiredActionIds = REQUIRED_HIGH_PRIVILEGE_ACTIONS,
} = {}) {
  const actionIds = highPrivilegeActionIds(taxonomy);
  const missingActionIds = requiredActionIds.filter((actionId) => !actionIds.includes(actionId));
  if (missingActionIds.length > 0) {
    throw new Error(`missing high-privilege actions: ${missingActionIds.join(", ")}`);
  }
  return {
    ok: true,
    actionIds,
  };
}

function missing(route, reason) {
  return {
    surface: route?.surface,
    command: route?.command,
    resource: route?.resource,
    verb: route?.verb,
    reason,
  };
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}
