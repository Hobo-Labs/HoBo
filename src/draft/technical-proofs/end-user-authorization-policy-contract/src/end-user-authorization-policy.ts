import {
  createBuiltInPolicyEngine,
  createRuleset,
  defineTypescriptRule,
  evaluatePolicy,
} from "../../built-in-policy-engine-contract/src/built-in-policy-engine.js";
import {
  POLICY_IR_SCHEMA_VERSION,
  createDecision,
  createDecisionRequest,
  createPolicyDecidedEvent,
} from "../../hobo-policy-ir-contract/src/policy-ir.js";
import { isJsonString, isJsonObject } from "./json.js";


export const USER_AUTHORIZATION_ENGINE_ID = "hobo.policy.user-authorization@0.1.0";

export function createUserAuthorizationRuleset({
  id = "policy-pack:end-user-authorization",
  version = "1.0.0",
  policyPacks = [],
  rules = [],
} = {}) {
  return createRuleset({ id, version, policyPacks, rules });
}

export function allow(input) {
  return Object.freeze({
    authoring: "allow-shorthand",
    ...normalizeOwnerRuleInput(input),
  });
}

export function lowerAllowToUserClaimRule(input) {
  if (!input || input.authoring !== "allow-shorthand") {
    throw new TypeError("allow shorthand must be created by allow()");
  }
  return ownerClaimPolicyRule(input);
}

export function ownerClaimPolicyRule(input) {
  const rule = normalizeOwnerRuleInput(input);
  return defineTypescriptRule({
    id: rule.id,
    when: ({ request }) =>
      request.phase === "runtime" &&
      request.action === rule.action &&
      request.resource.kind === rule.resourceKind,
    decide: ({ request }) => decideOwnerClaim(request, rule),
  });
}

export function authorizeUserRecord({
  ctx,
  action,
  resource,
  record,
  requestBody = {},
  ruleset = createUserAuthorizationRuleset(),
  phase = "runtime",
}) {
  const user = verifiedUserFromContext(ctx);
  const request = user
    ? createVerifiedUserRequest({ user, action, resource, record, requestBody, phase })
    : createUnverifiedUserRequest({ ctx, action, resource, record, requestBody, phase });
  const decision = user
    ? evaluatePolicy(
      createBuiltInPolicyEngine({ engineId: USER_AUTHORIZATION_ENGINE_ID }),
      request,
      ruleset,
    )
    : createUnverifiedUserDecision(request);

  return {
    request,
    decision,
    auditEvent: createPolicyDecidedEvent({ request, decision }),
  };
}

function decideOwnerClaim(request, rule) {
  const user = expectObject(request.context.user, "request.context.user");
  const record = expectObject(request.context.record, "request.context.record");
  const owner = record[rule.ownerField];
  const tenant = record[rule.tenantField];
  const violations = forgedRequestBodyViolations(request, rule);

  if (rule.requiredScope && !stringArray(user.scopes).includes(rule.requiredScope)) {
    return {
      effect: "deny",
      reason: "ctx.user missing required scope",
      violations: [
        `ctx.user missing required scope ${rule.requiredScope}`,
        ...violations,
      ],
    };
  }

  if (tenant !== user.tenantId) {
    return {
      effect: "deny",
      reason: "record tenant claim did not match ctx.user",
      violations: [
        `record tenant ${String(tenant)} does not match subject tenant ${user.tenantId}`,
        ...violations,
      ],
    };
  }

  if (owner !== request.subject.id) {
    return {
      effect: "deny",
      reason: "record owner claim did not match ctx.user",
      violations: [
        `record owner ${String(owner)} does not match subject ${request.subject.id}`,
        ...violations,
      ],
    };
  }

  return {
    effect: "allow",
    reason: "record owner claim satisfied",
  };
}

function forgedRequestBodyViolations(request, rule) {
  const bodyClaims = request.context.requestBodyClaims;
  if (!bodyClaims || !isJsonObject(bodyClaims) || Array.isArray(bodyClaims)) {
    return [];
  }
  const violations = [];
  if (bodyClaims.hasUserClaim === true) {
    violations.push("request body user claims are ignored");
  }
  if (Array.isArray(bodyClaims.fields) && bodyClaims.fields.includes(rule.ownerField)) {
    violations.push(`request body ${rule.ownerField} claim is ignored`);
  }
  return violations;
}

function createVerifiedUserRequest({ user, action, resource, record, requestBody, phase }) {
  return createDecisionRequest({
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: {
      kind: "user",
      id: user.id,
      roles: user.roles,
      scopes: user.scopes,
    },
    action: nonEmptyString(action, "action"),
    resource: normalizeResource(resource),
    phase,
    context: {
      claimSource: "ctx.user.verified",
      user: {
        id: user.id,
        roles: user.roles,
        scopes: user.scopes,
        tenantId: user.tenantId,
      },
      record: jsonClone(record ?? {}),
      requestBodyClaims: requestBodyClaimHints(requestBody),
    },
  });
}

function createUnverifiedUserRequest({ ctx, action, resource, record, requestBody, phase }) {
  return createDecisionRequest({
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: {
      kind: "system",
      id: "ctx.user:unverified",
    },
    action: nonEmptyString(action, "action"),
    resource: normalizeResource(resource),
    phase,
    context: {
      claimSource: "ctx.user.unverified",
      userState: ctx?.user ? "unverified" : "absent",
      record: jsonClone(record ?? {}),
      requestBodyClaims: requestBodyClaimHints(requestBody),
    },
  });
}

function createUnverifiedUserDecision(request) {
  return createDecision(request, {
    effect: "deny",
    reason: "ctx.user must be verified before user authorization",
    violations: ["ctx.user is absent or unresolved"],
    evidence: {
      engine: USER_AUTHORIZATION_ENGINE_ID,
      policyIds: [],
    },
  });
}

function verifiedUserFromContext(ctx) {
  const user = ctx?.user;
  if (!user || !isJsonObject(user) || Array.isArray(user)) {
    return undefined;
  }
  if (user.verified !== true || !isNonEmptyString(user.id) || !isNonEmptyString(user.tenantId)) {
    return undefined;
  }
  return {
    id: user.id,
    roles: stringArray(user.roles),
    scopes: stringArray(user.scopes),
    tenantId: user.tenantId,
  };
}

function normalizeOwnerRuleInput(input) {
  const source = expectObject(input, "owner rule");
  return Object.freeze({
    id: nonEmptyString(source.id, "owner rule id"),
    action: nonEmptyString(source.action, "owner rule action"),
    resourceKind: nonEmptyString(source.resourceKind, "owner rule resourceKind"),
    ownerField: nonEmptyString(source.ownerField, "owner rule ownerField"),
    tenantField: nonEmptyString(source.tenantField, "owner rule tenantField"),
    requiredScope: source.requiredScope === undefined
      ? undefined
      : nonEmptyString(source.requiredScope, "owner rule requiredScope"),
  });
}

function normalizeResource(resource) {
  const source = expectObject(resource, "resource");
  return {
    kind: nonEmptyString(source.kind, "resource.kind"),
    id: nonEmptyString(source.id, "resource.id"),
  };
}

function expectObject(value, name) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function nonEmptyString(value, name) {
  if (!isNonEmptyString(value)) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function stringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.filter(isNonEmptyString))].sort();
}

function requestBodyClaimHints(value) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    return {
      hasUserClaim: false,
      fields: [],
    };
  }
  return {
    hasUserClaim: Object.hasOwn(value, "user"),
    fields: Object.keys(value).sort(),
  };
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}
