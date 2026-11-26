import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const POLICY_ENGINE_SCHEMA = "hobo.policy-engine/v1";
export const POLICY_RULESET_SCHEMA = "hobo.policy-ruleset/v1";
export const POLICY_REQUEST_SCHEMA = "hobo.policy-ir/v1";
export const POLICY_DECISION_SCHEMA = "hobo.policy-ir.decision/v1";
export const POLICY_ENGINE_PORT = "hobo:policy-engine/policy-engine@0.1.0";
export const BUILT_IN_ENGINE_ID = "hobo.policy-engine/built-in-typescript@0.1.0";

const EFFECTS = new Set(["allow", "allow-degraded", "deny", "warn", "mutate", "require-approval"]);
const PHASES = new Set(["author", "local", "test", "plan", "apply", "runtime", "observe", "train", "promote", "repair"]);
const SUBJECT_KINDS = new Set(["user", "service", "agent", "system"]);
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const AMBIENT_TOKENS = [
  "Date.now",
  "new Date",
  "Math.random",
  "crypto.randomUUID",
  "performance.now",
  "process.hrtime"
];

export function createGoldenDecisionRequest(overrides = {}) {
  return deepMerge(
    {
      schema: POLICY_REQUEST_SCHEMA,
      subject: {
        kind: "agent",
        id: "spiffe://tenant-a/bindle/shop/agent/deployer",
        roles: ["deployer"],
        scopes: ["deployment.apply"],
        delegatedBy: "user:platform-admin"
      },
      action: "deployment.apply",
      resource: {
        kind: "deployment",
        id: "deployment:checkout/prod"
      },
      phase: "plan",
      context: {
        provider: "local",
        riskScore: 0.12
      }
    },
    overrides
  );
}

export function defineTypescriptRule({ id, when, decide }) {
  return { id, when, decide, authoring: "typed-typescript-rule" };
}

export function createRuleset({ id = "policy-pack:default", version = "1.0.0", rules = [] } = {}) {
  return {
    schema: POLICY_RULESET_SCHEMA,
    id,
    version,
    rules
  };
}

export function compileRulesetContract(ruleset) {
  const compiled = compileRuleset(ruleset);

  return {
    ok: compiled.ok,
    errors: compiled.errors,
    compiled: compiled.ok
      ? {
          rulesetId: ruleset.id,
          version: ruleset.version,
          ruleIds: ruleset.rules.map((rule) => rule.id)
        }
      : null
  };
}

export function createBuiltInPolicyEngine({ engineId = BUILT_IN_ENGINE_ID } = {}) {
  return {
    engineId,
    evaluate(request, ruleset) {
      return evaluateBuiltIn(engineId, request, ruleset);
    }
  };
}

export function createNoopDenyAdapter({ engineId = "hobo.policy-engine/noop-deny@0.1.0" } = {}) {
  return {
    engineId,
    evaluate(request) {
      return denyDecision({
        engineId,
        request,
        reason: "noop adapter denies all policy requests",
        violations: []
      });
    }
  };
}

export function createPermissiveAdapter({ engineId = "example.permissive-policy-engine@0.1.0" } = {}) {
  return {
    engineId,
    evaluate(request) {
      return makeDecision({
        engineId,
        request,
        effect: "allow",
        reason: "permissive adapter allowed without ruleset mapping",
        policyIds: ["permissive:*"]
      });
    }
  };
}

export function evaluatePolicy(engine, request, ruleset) {
  if (!engine || !(engine.evaluate instanceof Function)) {
    throw new Error("engine must implement evaluate(request, ruleset)");
  }
  return normalizeDecision(engine.evaluate(request, ruleset), engine.engineId, request);
}

export function runPolicyEngineConformance(engine) {
  const errors = [];
  const request = createGoldenDecisionRequest({ action: "unmapped.control-plane.action" });
  const emptyRuleset = createRuleset({ rules: [] });

  const defaultDecision = evaluatePolicy(engine, request, emptyRuleset);
  if (defaultDecision.effect !== "deny") {
    errors.push("deny-by-default: unmapped action must return deny");
  }
  if (defaultDecision.evidence.engine !== engine.engineId) {
    errors.push("evidence.engine must identify the adapter that made the decision");
  }

  const repeated = evaluatePolicy(engine, structuredClone(request), emptyRuleset);
  if (canonicalJson(defaultDecision) !== canonicalJson(repeated)) {
    errors.push("determinism: same request and ruleset must return byte-stable decisions");
  }

  const compileFailure = evaluatePolicy(
    engine,
    createGoldenDecisionRequest(),
    createRuleset({
      version: "",
      rules: [
        defineTypescriptRule({
          id: "ambient-random-rule",
          when: () => Math.random() > -1,
          decide: () => ({ effect: "allow", reason: "ambient random" })
        })
      ]
    })
  );

  if (compileFailure.effect !== "deny") {
    errors.push("fail-closed: invalid or non-pure rulesets must return deny");
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function evaluateBuiltIn(engineId, request, ruleset) {
  const requestErrors = validateRequest(request);
  if (requestErrors.length > 0) {
    return denyDecision({
      engineId,
      request,
      reason: "request validation failed",
      violations: requestErrors
    });
  }

  const compile = compileRuleset(ruleset);
  if (!compile.ok) {
    return denyDecision({
      engineId,
      request,
      reason: `ruleset compile failed: ${ruleset?.id ?? "unknown"}`,
      violations: compile.errors
    });
  }

  for (const rule of compile.rules) {
    if (!rule.when({ request })) {
      continue;
    }

    const partial = rule.decide({ request });
    if (!EFFECTS.has(partial.effect)) {
      return denyDecision({
        engineId,
        request,
        reason: `ruleset compile failed: ${ruleset.id}`,
        violations: [`${rule.id}: effect must be one of ${[...EFFECTS].join(", ")}`]
      });
    }

    return makeDecision({
      engineId,
      request,
      effect: partial.effect,
      reason: partial.reason,
      policyIds: [rule.id],
      violations: partial.violations,
      mutations: partial.mutations,
      approvals: partial.approvals,
      obligations: partial.obligations
    });
  }

  return denyDecision({
    engineId,
    request,
    reason: "deny-by-default: no rule matched action",
    violations: [`no policy rule mapped ${request.action}`]
  });
}

function compileRuleset(ruleset) {
  const errors = [];

  if (!ruleset || !isJsonObject(ruleset) || Array.isArray(ruleset)) {
    return { ok: false, errors: ["ruleset must be an object"], rules: [] };
  }
  if (ruleset.schema !== POLICY_RULESET_SCHEMA) {
    errors.push(`ruleset.schema must be ${POLICY_RULESET_SCHEMA}`);
  }
  if (!isNonEmptyString(ruleset.id)) {
    errors.push("ruleset.id must be a non-empty string");
  }
  if (!SEMVER_RE.test(ruleset.version ?? "")) {
    errors.push("ruleset.version must be semver");
  }
  if (!Array.isArray(ruleset.rules)) {
    errors.push("ruleset.rules must be an array");
    return { ok: false, errors, rules: [] };
  }

  for (const rule of ruleset.rules) {
    validateRule(rule, errors);
  }

  return {
    ok: errors.length === 0,
    errors,
    rules: errors.length === 0 ? ruleset.rules : []
  };
}

function validateRule(rule, errors) {
  if (!rule || !isJsonObject(rule) || Array.isArray(rule)) {
    errors.push("rule must be an object");
    return;
  }
  if (!isNonEmptyString(rule.id)) {
    errors.push("rule.id must be a non-empty string");
  }
  if (!(rule.when instanceof Function)) {
    errors.push(`${rule.id ?? "rule"}: when must be a function`);
  }
  if (!(rule.decide instanceof Function)) {
    errors.push(`${rule.id ?? "rule"}: decide must be a function`);
  }

  for (const [name, fn] of [["when", rule.when], ["decide", rule.decide]]) {
    if (!(fn instanceof Function)) {
      continue;
    }
    const source = Function.prototype.toString.call(fn);
    for (const token of AMBIENT_TOKENS) {
      if (source.includes(token)) {
        errors.push(`${rule.id}: ${name} uses ambient ${token}`);
      }
    }
  }

}

function validateRequest(request) {
  const errors = [];

  if (!request || !isJsonObject(request) || Array.isArray(request)) {
    return ["request must be an object"];
  }
  if (request.schema !== POLICY_REQUEST_SCHEMA) {
    errors.push(`request.schema must be ${POLICY_REQUEST_SCHEMA}`);
  }
  if (!request.subject || !isJsonObject(request.subject)) {
    errors.push("request.subject must be present");
  } else {
    if (!SUBJECT_KINDS.has(request.subject.kind)) {
      errors.push("request.subject.kind must be user, service, agent, or system");
    }
    if (!isNonEmptyString(request.subject.id)) {
      errors.push("request.subject.id must be a non-empty string");
    }
  }
  if (!isNonEmptyString(request.action)) {
    errors.push("request.action must be a non-empty string");
  }
  if (!request.resource || !isJsonObject(request.resource)) {
    errors.push("request.resource must be present");
  } else {
    if (!isNonEmptyString(request.resource.kind)) {
      errors.push("request.resource.kind must be a non-empty string");
    }
    if (!isNonEmptyString(request.resource.id)) {
      errors.push("request.resource.id must be a non-empty string");
    }
  }
  if (!PHASES.has(request.phase)) {
    errors.push(`request.phase must be one of ${[...PHASES].join(", ")}`);
  }

  return errors;
}

function denyDecision({ engineId, request, reason, violations }) {
  return makeDecision({
    engineId,
    request,
    effect: "deny",
    reason,
    violations,
    policyIds: []
  });
}

function makeDecision({
  engineId,
  request,
  effect,
  reason,
  policyIds = [],
  violations = [],
  mutations = [],
  approvals = [],
  obligations = []
}) {
  return {
    schema: POLICY_DECISION_SCHEMA,
    effect,
    reason,
    violations: violations ?? [],
    mutations: mutations ?? [],
    approvals: approvals ?? [],
    obligations: obligations ?? [],
    evidence: {
      engine: engineId,
      inputHash: hashInput(request),
      policyIds
    }
  };
}

function normalizeDecision(decision, fallbackEngineId, request) {
  if (!decision || !isJsonObject(decision) || Array.isArray(decision)) {
    return denyDecision({
      engineId: fallbackEngineId,
      request,
      reason: "adapter returned invalid decision",
      violations: ["decision must be an object"]
    });
  }
  return {
    schema: decision.schema ?? POLICY_DECISION_SCHEMA,
    effect: decision.effect,
    reason: decision.reason ?? "",
    violations: decision.violations ?? [],
    mutations: decision.mutations ?? [],
    approvals: decision.approvals ?? [],
    obligations: decision.obligations ?? [],
    evidence: {
      engine: decision.evidence?.engine ?? fallbackEngineId,
      inputHash: decision.evidence?.inputHash ?? hashInput(request),
      policyIds: decision.evidence?.policyIds ?? []
    }
  };
}

function hashInput(request) {
  return `sha256:${createHash("sha256").update(canonicalJson(request ?? null)).digest("hex")}`;
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
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
