import {
  composePolicyPacks,
} from "../../deny-ceiling-algebra-poc/src/deny-ceiling-algebra.js";
import {
  createDecision,
  createDecisionRequest,
  createPolicyDecidedEvent,
  POLICY_IR_SCHEMA_VERSION,
} from "../../hobo-policy-ir-contract/src/policy-ir.js";
import { isJsonString, isJsonObject } from "./json.js";


export const BUILT_IN_POLICY_ENGINE_ID = "hobo.policy-engine/built-in-typescript@0.1.0";
export const POLICY_RULESET_SCHEMA_VERSION = "hobo.policy-ruleset/v1";
export const BUILT_IN_POLICY_ENGINE_EXECUTION_MODE = "yard-local";

const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const EFFECT_RANK = new Map([
  ["deny", 0],
  ["require-approval", 1],
  ["mutate", 2],
  ["allow-degraded", 3],
  ["warn", 4],
  ["allow", 5],
]);

export function createGoldenDecisionRequest(overrides = {}) {
  return createDecisionRequest(
    deepMerge(
      {
        schemaVersion: POLICY_IR_SCHEMA_VERSION,
        subject: {
          kind: "agent",
          id: "spiffe://tenant-a/yard/prod/agent/deployer",
          roles: ["deployer"],
          scopes: ["hobo:deployment:apply"],
          delegatedBy: "user:platform-admin",
        },
        action: "hobo:deployment:apply",
        resource: {
          kind: "deployment",
          id: "deployment:checkout-prod",
        },
        phase: "plan",
        context: {
          yard: "yard-prod",
          provider: "local",
        },
      },
      overrides,
    ),
  );
}

export function defineTypescriptRule({ id, when, decide }) {
  return {
    authoring: "typed-typescript-rule",
    id,
    when,
    decide,
  };
}

export function createRuleset({
  id = "policy-pack:built-in-default",
  version = "1.0.0",
  policyPacks = [],
  rules = [],
} = {}) {
  return {
    schemaVersion: POLICY_RULESET_SCHEMA_VERSION,
    id,
    version,
    policyPacks,
    rules,
  };
}

export function createBuiltInPolicyEngine({ engineId = BUILT_IN_POLICY_ENGINE_ID } = {}) {
  return {
    engineId,
    executionMode: BUILT_IN_POLICY_ENGINE_EXECUTION_MODE,
    evaluate(request, ruleset) {
      return evaluateBuiltInPolicy(engineId, request, ruleset);
    },
  };
}

export function evaluatePolicy(engine, request, ruleset) {
  if (!engine || !(engine.evaluate instanceof Function)) {
    throw new TypeError("engine must implement evaluate(request, ruleset)");
  }
  return engine.evaluate(request, ruleset);
}

export async function evaluateAndRecordPolicyDecision({ engine, request, ruleset, auditSink }) {
  if (!(auditSink instanceof Function)) {
    throw new TypeError("auditSink must be a function");
  }

  const decision = evaluatePolicy(engine, request, ruleset);
  const event = createPolicyDecidedEvent({ request, decision });

  await Promise.resolve();
  await auditSink(event);

  return decision;
}

export function requestTuple(requestInput) {
  const request = createDecisionRequest(requestInput);
  return `${request.resource.kind}:${request.action}:${request.phase}`;
}

function evaluateBuiltInPolicy(engineId, requestInput, rulesetInput) {
  let request;
  try {
    request = createDecisionRequest(requestInput);
  } catch (error) {
    return createRawDenyDecision({
      engineId,
      requestInput,
      reason: "request validation failed",
      violations: [error.message],
    });
  }

  const compiled = compileRuleset(rulesetInput);
  if (!compiled.ok) {
    return makeDecision({
      engineId,
      request,
      effect: "deny",
      reason: `ruleset compile failed: ${rulesetInput?.id ?? "unknown"}`,
      policyIds: [],
      violations: compiled.errors,
    });
  }

  const composition = composePolicyPacks(compiled.policyPacks);
  if (!composition.ok) {
    return makeDecision({
      engineId,
      request,
      effect: "deny",
      reason: `deny-ceiling composition failed: ${compiled.id}`,
      policyIds: compositionFailurePolicyIds(composition),
      violations: [...composition.errors, ...composition.violations],
    });
  }

  const compositionDeny = matchingCompositionDeny(composition, requestTuple(request));
  if (compositionDeny) {
    const reason =
      compositionDeny.mode === "mandatory"
        ? `deny-ceiling matched ${compositionDeny.tuple}`
        : `policy composition denied ${compositionDeny.tuple}`;
    return makeDecision({
      engineId,
      request,
      effect: "deny",
      reason,
      policyIds: compositionDeny.sources,
      violations: [`policy composition denies ${compositionDeny.tuple}`],
    });
  }

  const matchedPartials = [];
  for (const rule of compiled.rules) {
    try {
      if (!rule.when({ request })) {
        continue;
      }
      const partial = rule.decide({ request });
      if (!partial || !isJsonObject(partial) || Array.isArray(partial)) {
        return ruleFailureDecision(engineId, request, rule, "decision must be an object");
      }
      if (!EFFECT_RANK.has(partial.effect)) {
        return ruleFailureDecision(
          engineId,
          request,
          rule,
          `effect must be one of ${[...EFFECT_RANK.keys()].join(", ")}`,
        );
      }
      matchedPartials.push({ rule, partial });
    } catch (error) {
      return ruleFailureDecision(engineId, request, rule, error.message);
    }
  }

  if (matchedPartials.length === 0) {
    return makeDecision({
      engineId,
      request,
      effect: "deny",
      reason: "deny-by-default: no rule matched action",
      policyIds: [],
      violations: [`no policy rule mapped ${request.action}`],
    });
  }

  const winning = matchedPartials
    .toSorted(comparePartials)
    .at(0);
  const allPartials = matchedPartials.toSorted((left, right) => left.rule.id.localeCompare(right.rule.id));

  return makeDecision({
    engineId,
    request,
    effect: winning.partial.effect,
    reason: winning.partial.reason,
    policyIds: allPartials.map(({ rule }) => rule.id),
    violations: allPartials.flatMap(({ partial }) => partial.violations ?? []),
    mutations: allPartials.flatMap(({ partial }) => partial.mutations ?? []),
    approvals: allPartials.flatMap(({ partial }) => partial.approvals ?? []),
    obligations: allPartials.flatMap(({ partial }) => partial.obligations ?? []),
  });
}

function compileRuleset(ruleset) {
  const errors = [];
  if (!ruleset || !isJsonObject(ruleset) || Array.isArray(ruleset)) {
    return { ok: false, errors: ["ruleset must be an object"], rules: [], policyPacks: [] };
  }
  if (ruleset.schemaVersion !== POLICY_RULESET_SCHEMA_VERSION) {
    errors.push(`ruleset.schemaVersion must be ${POLICY_RULESET_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(ruleset.id)) {
    errors.push("ruleset.id must be a non-empty string");
  }
  if (!SEMVER_RE.test(ruleset.version ?? "")) {
    errors.push("ruleset.version must be semver");
  }
  if (!Array.isArray(ruleset.policyPacks)) {
    errors.push("ruleset.policyPacks must be an array");
  }
  if (!Array.isArray(ruleset.rules)) {
    errors.push("ruleset.rules must be an array");
    return { ok: false, errors, rules: [], policyPacks: [] };
  }

  const ruleIds = new Set();
  for (const rule of ruleset.rules) {
    validateRule(rule, ruleIds, errors);
  }

  return {
    ok: errors.length === 0,
    errors,
    id: ruleset.id,
    version: ruleset.version,
    rules: errors.length === 0 ? ruleset.rules.toSorted((left, right) => left.id.localeCompare(right.id)) : [],
    policyPacks: errors.length === 0 ? ruleset.policyPacks : [],
  };
}

function validateRule(rule, ruleIds, errors) {
  if (!rule || !isJsonObject(rule) || Array.isArray(rule)) {
    errors.push("rule must be an object");
    return;
  }
  if (!isNonEmptyString(rule.id)) {
    errors.push("rule.id must be a non-empty string");
  } else if (ruleIds.has(rule.id)) {
    errors.push(`${rule.id}: duplicate rule id`);
  } else {
    ruleIds.add(rule.id);
  }
  if (!(rule.when instanceof Function)) {
    errors.push(`${rule.id ?? "rule"}: when must be a function`);
  }
  if (!(rule.decide instanceof Function)) {
    errors.push(`${rule.id ?? "rule"}: decide must be a function`);
  }
}

function matchingCompositionDeny(composition, tuple) {
  return composition.effectiveDenySet.find(
    (entry) => entry.tuple === tuple,
  );
}

function compositionFailurePolicyIds(composition) {
  return unique([
    ...composition.effectiveDenySet.flatMap((entry) => entry.sources ?? []),
    ...composition.violations.flatMap((violation) => {
      const match = /^(?<source>\S+) attempts to allow/.exec(violation);
      return match?.groups?.source ? [match.groups.source] : [];
    }),
  ]);
}

function ruleFailureDecision(engineId, request, rule, violation) {
  return makeDecision({
    engineId,
    request,
    effect: "deny",
    reason: `rule evaluation failed: ${rule.id}`,
    policyIds: [rule.id],
    violations: [`${rule.id}: ${violation}`],
  });
}

function makeDecision({
  engineId,
  request,
  effect,
  reason,
  policyIds,
  violations = [],
  mutations = [],
  approvals = [],
  obligations = [],
}) {
  return createDecision(request, {
    effect,
    reason,
    violations,
    mutations,
    approvals,
    obligations,
    evidence: {
      engine: engineId,
      policyIds: unique(policyIds),
    },
  });
}

function createRawDenyDecision({ engineId, requestInput, reason, violations }) {
  const fallbackRequest = createDecisionRequest({
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: {
      kind: "system",
      id: "policy-engine",
    },
    action: "policy.invalid-request",
    resource: {
      kind: "policy-request",
      id: "invalid",
    },
    phase: "runtime",
    context: {
      invalidRequest: safeJson(requestInput),
    },
  });

  return makeDecision({
    engineId,
    request: fallbackRequest,
    effect: "deny",
    reason,
    policyIds: [],
    violations,
  });
}

function comparePartials(left, right) {
  const rankCompare = EFFECT_RANK.get(left.partial.effect) - EFFECT_RANK.get(right.partial.effect);
  if (rankCompare !== 0) {
    return rankCompare;
  }
  return left.rule.id.localeCompare(right.rule.id);
}

function unique(values) {
  return [...new Set(values.filter(isNonEmptyString))];
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
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
