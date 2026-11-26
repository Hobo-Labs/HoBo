import {
  allowRule,
  composePolicyPacks,
  definePolicyPack,
  denyRule,
} from "../../deny-ceiling-algebra-poc/src/deny-ceiling-algebra.js";
import {
  POLICY_RULESET_SCHEMA_VERSION,
  createBuiltInPolicyEngine,
  createGoldenDecisionRequest,
  createRuleset,
  defineTypescriptRule,
  evaluatePolicy,
  requestTuple,
} from "../../built-in-policy-engine-contract/src/built-in-policy-engine.js";
import {
  POLICY_IR_SCHEMA_VERSION,
  canonicalJson,
  createDecision,
  createDecisionRequest,
} from "../../hobo-policy-ir-contract/src/policy-ir.js";
import { isJsonString, isJsonObject } from "./json.js";


export const OPA_REGO_POLICY_ENGINE_ID = "hobo.policy-engine/provider-opa-rego@0.1.0";
export const CEDAR_POLICY_ENGINE_ID = "hobo.policy-engine/provider-cedar@0.1.0";
export const OPA_REGO_EXECUTION_MODE = "opa-rego-wasm";
export const CEDAR_EXECUTION_MODE = "cedar-abac";

const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const EFFECT_RANK = new Map([
  ["deny", 0],
  ["require-approval", 1],
  ["mutate", 2],
  ["allow-degraded", 3],
  ["warn", 4],
  ["allow", 5],
]);

export function mapDecisionRequestToOpaInput(requestInput) {
  const request = createDecisionRequest(requestInput);
  return {
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    tuple: requestTuple(request),
    subject: structuredClone(request.subject),
    action: request.action,
    resource: structuredClone(request.resource),
    phase: request.phase,
    context: structuredClone(request.context ?? {}),
  };
}

export function mapDecisionRequestToCedarRequest(requestInput) {
  const request = createDecisionRequest(requestInput);
  return {
    principal: {
      type: request.subject.kind,
      id: request.subject.id,
      roles: structuredClone(request.subject.roles ?? []),
      scopes: structuredClone(request.subject.scopes ?? []),
      ...(request.subject.delegatedBy === undefined ? undefined : { delegatedBy: request.subject.delegatedBy }),
    },
    action: {
      id: request.action,
    },
    resource: {
      type: request.resource.kind,
      id: request.resource.id,
    },
    context: {
      ...structuredClone(request.context ?? {}),
      phase: request.phase,
      tuple: requestTuple(request),
    },
  };
}

export function defineOpaRegoPolicy({ id, match, decide }) {
  return {
    dialect: "opa-rego",
    id,
    match,
    decide,
  };
}

export function defineCedarPolicy({ id, when, decide }) {
  return {
    dialect: "cedar",
    id,
    when,
    decide,
  };
}

export function createPolicyEngineAdapterRuleset({
  id = "policy-pack:provider-adapter-conformance",
  version = "1.0.0",
  policyPacks = [],
  rules = [],
  opaPolicies = [],
  cedarPolicies = [],
} = {}) {
  return {
    ...createRuleset({ id, version, policyPacks, rules }),
    opaPolicies,
    cedarPolicies,
  };
}

export function createOpaRegoPolicyEngineAdapter({ engineId = OPA_REGO_POLICY_ENGINE_ID } = {}) {
  return {
    engineId,
    executionMode: OPA_REGO_EXECUTION_MODE,
    evaluate(request, ruleset) {
      return evaluateAdapterPolicy({
        dialect: "opa-rego",
        dialectLabel: "OPA/Rego",
        engineId,
        policyField: "opaPolicies",
        request,
        ruleset,
        mapRequest: mapDecisionRequestToOpaInput,
        matchesPolicy(policy, context) {
          return policy.match(context);
        },
      });
    },
  };
}

export function createCedarPolicyEngineAdapter({ engineId = CEDAR_POLICY_ENGINE_ID } = {}) {
  return {
    engineId,
    executionMode: CEDAR_EXECUTION_MODE,
    evaluate(request, ruleset) {
      return evaluateAdapterPolicy({
        dialect: "cedar",
        dialectLabel: "Cedar",
        engineId,
        policyField: "cedarPolicies",
        request,
        ruleset,
        mapRequest: mapDecisionRequestToCedarRequest,
        matchesPolicy(policy, context) {
          return policy.when({ authorization: context.authorization, request: context.request });
        },
      });
    },
  };
}

export function createAdapterConformanceFixture() {
  const allowRequest = createGoldenDecisionRequest();
  const denyByDefaultRequest = createGoldenDecisionRequest({
    action: "hobo:secret:value-read",
    resource: { kind: "secret", id: "secret:prod/api-key" },
    phase: "runtime",
  });
  const denyCeilingRequest = createGoldenDecisionRequest({ phase: "runtime" });
  const denyCeilingTuple = requestTuple(denyCeilingRequest);
  const wideningRequest = createGoldenDecisionRequest({ phase: "apply" });
  const wideningTuple = requestTuple(wideningRequest);

  return {
    engines: [
      createBuiltInPolicyEngine(),
      createOpaRegoPolicyEngineAdapter(),
      createCedarPolicyEngineAdapter(),
    ],
    vectors: [
      {
        name: "allow mapped deployment plan",
        request: allowRequest,
        ruleset: createPolicyEngineAdapterRuleset({
          rules: [allowDeploymentPlanTypescriptRule()],
          opaPolicies: [allowDeploymentPlanOpaPolicy()],
          cedarPolicies: [allowDeploymentPlanCedarPolicy()],
        }),
        expectedEffect: "allow",
      },
      {
        name: "deny-by-default unmapped action",
        request: denyByDefaultRequest,
        ruleset: createPolicyEngineAdapterRuleset({
          rules: [allowDeploymentPlanTypescriptRule()],
          opaPolicies: [allowDeploymentPlanOpaPolicy()],
          cedarPolicies: [allowDeploymentPlanCedarPolicy()],
        }),
        expectedEffect: "deny",
        expectedReason: /deny-by-default/,
      },
      {
        name: "mandatory deny-ceiling overrides adapter allow",
        request: denyCeilingRequest,
        ruleset: createPolicyEngineAdapterRuleset({
          policyPacks: [
            definePolicyPack({
              id: "junction-runtime",
              scope: "junction",
              rules: [denyRule({ id: "no-runtime-deploy", tuple: denyCeilingTuple })],
            }),
          ],
          rules: [
            defineTypescriptRule({
              id: "allow-runtime-deploy",
              when: () => true,
              decide: () => ({ effect: "allow", reason: "typed policy attempted allow" }),
            }),
          ],
          opaPolicies: [
            defineOpaRegoPolicy({
              id: "opa.allow-runtime-deploy",
              match: () => true,
              decide: () => ({ effect: "allow", reason: "rego policy attempted allow" }),
            }),
          ],
          cedarPolicies: [
            defineCedarPolicy({
              id: "cedar.allow-runtime-deploy",
              when: () => true,
              decide: () => ({ effect: "allow", reason: "cedar policy attempted allow" }),
            }),
          ],
        }),
        expectedEffect: "deny",
        expectedReason: /deny-ceiling matched/,
      },
      {
        name: "lower-scope allow cannot widen a mandatory deny-ceiling",
        request: wideningRequest,
        ruleset: createPolicyEngineAdapterRuleset({
          policyPacks: [
            definePolicyPack({
              id: "junction-prod",
              scope: "junction",
              rules: [denyRule({ id: "no-prod-apply", tuple: wideningTuple })],
            }),
            definePolicyPack({
              id: "bindle-escape",
              scope: "bindle",
              rules: [allowRule({ id: "allow-prod-apply", tuple: wideningTuple })],
            }),
          ],
          rules: [
            defineTypescriptRule({
              id: "typed-allow-apply",
              when: () => true,
              decide: () => ({ effect: "allow", reason: "typed policy attempted widening" }),
            }),
          ],
          opaPolicies: [
            defineOpaRegoPolicy({
              id: "opa.allow-prod-apply",
              match: () => true,
              decide: () => ({ effect: "allow", reason: "rego policy attempted widening" }),
            }),
          ],
          cedarPolicies: [
            defineCedarPolicy({
              id: "cedar.allow-prod-apply",
              when: () => true,
              decide: () => ({ effect: "allow", reason: "cedar policy attempted widening" }),
            }),
          ],
        }),
        expectedEffect: "deny",
        expectedReason: /deny-ceiling composition failed/,
      },
      {
        name: "policy evaluation errors fail closed",
        request: allowRequest,
        ruleset: createPolicyEngineAdapterRuleset({
          rules: [
            defineTypescriptRule({
              id: "typed.buggy-policy",
              when: () => true,
              decide: () => {
                throw new Error("typed bundle unavailable");
              },
            }),
          ],
          opaPolicies: [
            defineOpaRegoPolicy({
              id: "opa.buggy-policy",
              match: () => true,
              decide: () => {
                throw new Error("rego bundle unavailable");
              },
            }),
          ],
          cedarPolicies: [
            defineCedarPolicy({
              id: "cedar.buggy-policy",
              when: () => true,
              decide: () => {
                throw new Error("cedar entity graph unavailable");
              },
            }),
          ],
        }),
        expectedEffect: "deny",
        expectedReason: /failed/,
      },
    ],
  };
}

export function runPolicyEngineAdapterConformance({ engines, vectors } = {}) {
  const fixture = createAdapterConformanceFixture();
  const conformanceEngines = engines ?? fixture.engines;
  const conformanceVectors = vectors ?? fixture.vectors;
  const errors = [];
  const results = [];

  for (const vector of conformanceVectors) {
    if (!vector) {
      errors.push("conformance vector must be present");
      continue;
    }

    for (const engine of conformanceEngines) {
      let first;
      let second;
      try {
        first = evaluatePolicy(engine, vector.request, vector.ruleset);
        second = evaluatePolicy(engine, structuredClone(vector.request), vector.ruleset);
      } catch (error) {
        errors.push(`${vector.name} ${engine?.engineId ?? "unknown"}: threw ${error.message}`);
        continue;
      }

      results.push({
        vector: vector.name,
        engineId: engine.engineId,
        decision: first,
      });

      if (first.effect !== vector.expectedEffect) {
        errors.push(`${vector.name} ${engine.engineId}: expected ${vector.expectedEffect}, got ${first.effect}`);
      }
      if (first.evidence.engine !== engine.engineId) {
        errors.push(`${vector.name} ${engine.engineId}: evidence.engine must identify the adapter`);
      }
      if (vector.expectedReason && !vector.expectedReason.test(first.reason)) {
        errors.push(`${vector.name} ${engine.engineId}: reason did not match ${vector.expectedReason}`);
      }
      if (canonicalJson(first) !== canonicalJson(second)) {
        errors.push(`${vector.name} ${engine.engineId}: decision must be deterministic`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    engines: conformanceEngines.map((engine) => ({ engineId: engine.engineId })),
    vectors: conformanceVectors.filter(Boolean).map((vector) => ({ name: vector.name })),
    results,
  };
}

export function assertPolicyEngineAdapterConformance(report) {
  if (!report?.ok) {
    throw new Error(report?.errors?.join("\n") || "policy-engine adapter conformance failed");
  }
  return report;
}

function allowDeploymentPlanTypescriptRule() {
  return defineTypescriptRule({
    id: "allow-deployment-plan",
    when: ({ request }) => request.action === "hobo:deployment:apply" && request.phase === "plan",
    decide: () => ({ effect: "allow", reason: "deployment plan passed policy" }),
  });
}

function allowDeploymentPlanOpaPolicy() {
  return defineOpaRegoPolicy({
    id: "opa.allow-deployment-plan",
    match: ({ input }) => input.action === "hobo:deployment:apply" && input.phase === "plan",
    decide: () => ({ effect: "allow", reason: "deployment plan passed Rego policy" }),
  });
}

function allowDeploymentPlanCedarPolicy() {
  return defineCedarPolicy({
    id: "cedar.allow-deployment-plan",
    when: ({ authorization }) => authorization.action.id === "hobo:deployment:apply"
      && authorization.context.phase === "plan",
    decide: () => ({ effect: "allow", reason: "deployment plan passed Cedar policy" }),
  });
}

function evaluateAdapterPolicy({
  dialect,
  dialectLabel,
  engineId,
  policyField,
  request: requestInput,
  ruleset: rulesetInput,
  mapRequest,
  matchesPolicy,
}) {
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

  const compiled = compileAdapterRuleset(rulesetInput, { policyField, dialect });
  if (!compiled.ok) {
    return makeDecision({
      engineId,
      request,
      effect: "deny",
      reason: `${dialectLabel} ruleset compile failed: ${rulesetInput?.id ?? "unknown"}`,
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

  const input = mapRequest(request);
  const matchedPartials = [];
  for (const policy of compiled.policies) {
    const context = { input, authorization: input, request };
    let matched;
    try {
      matched = matchesPolicy(policy, context);
      if (!matched) {
        continue;
      }
      const partial = policy.decide(context);
      if (!partial || !isJsonObject(partial) || Array.isArray(partial)) {
        return policyFailureDecision({ engineId, request, policy, dialectLabel, violation: "decision must be an object" });
      }
      if (!EFFECT_RANK.has(partial.effect)) {
        return policyFailureDecision({
          engineId,
          request,
          policy,
          dialectLabel,
          violation: `effect must be one of ${[...EFFECT_RANK.keys()].join(", ")}`,
        });
      }
      matchedPartials.push({ policy, partial });
    } catch (error) {
      return policyFailureDecision({ engineId, request, policy, dialectLabel, violation: error.message });
    }
  }

  if (matchedPartials.length === 0) {
    return makeDecision({
      engineId,
      request,
      effect: "deny",
      reason: `deny-by-default: no ${dialectLabel} policy matched action`,
      policyIds: [],
      violations: [`no ${dialectLabel} policy mapped ${request.action}`],
    });
  }

  const winning = matchedPartials.toSorted(comparePartials).at(0);
  const allPartials = matchedPartials.toSorted((left, right) => left.policy.id.localeCompare(right.policy.id));

  return makeDecision({
    engineId,
    request,
    effect: winning.partial.effect,
    reason: winning.partial.reason,
    policyIds: allPartials.map(({ policy }) => policy.id),
    violations: allPartials.flatMap(({ partial }) => partial.violations ?? []),
    mutations: allPartials.flatMap(({ partial }) => partial.mutations ?? []),
    approvals: allPartials.flatMap(({ partial }) => partial.approvals ?? []),
    obligations: allPartials.flatMap(({ partial }) => partial.obligations ?? []),
  });
}

function compileAdapterRuleset(ruleset, { policyField, dialect }) {
  const errors = [];
  if (!ruleset || !isJsonObject(ruleset) || Array.isArray(ruleset)) {
    return { ok: false, errors: ["ruleset must be an object"], policies: [], policyPacks: [] };
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

  const policies = ruleset[policyField] ?? [];
  if (!Array.isArray(policies)) {
    errors.push(`ruleset.${policyField} must be an array`);
  } else {
    validatePolicies(policies, dialect, errors);
  }

  return {
    ok: errors.length === 0,
    errors,
    id: ruleset.id,
    version: ruleset.version,
    policies: errors.length === 0 ? policies.toSorted((left, right) => left.id.localeCompare(right.id)) : [],
    policyPacks: errors.length === 0 ? ruleset.policyPacks : [],
  };
}

function validatePolicies(policies, dialect, errors) {
  const ids = new Set();
  for (const policy of policies) {
    if (!policy || !isJsonObject(policy) || Array.isArray(policy)) {
      errors.push(`${dialect} policy must be an object`);
      continue;
    }
    if (policy.dialect !== dialect) {
      errors.push(`${policy.id ?? dialect} dialect must be ${dialect}`);
    }
    if (!isNonEmptyString(policy.id)) {
      errors.push(`${dialect} policy.id must be a non-empty string`);
    } else if (ids.has(policy.id)) {
      errors.push(`${policy.id}: duplicate ${dialect} policy id`);
    } else {
      ids.add(policy.id);
    }
    if (dialect === "opa-rego" && !(policy.match instanceof Function)) {
      errors.push(`${policy.id ?? "opa-rego"}: match must be a function`);
    }
    if (dialect === "cedar" && !(policy.when instanceof Function)) {
      errors.push(`${policy.id ?? "cedar"}: when must be a function`);
    }
    if (!(policy.decide instanceof Function)) {
      errors.push(`${policy.id ?? dialect}: decide must be a function`);
    }
  }
}

function matchingCompositionDeny(composition, tuple) {
  return composition.effectiveDenySet.find((entry) => entry.tuple === tuple);
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

function policyFailureDecision({ engineId, request, policy, dialectLabel, violation }) {
  return makeDecision({
    engineId,
    request,
    effect: "deny",
    reason: `${dialectLabel} policy evaluation failed: ${policy.id}`,
    policyIds: [policy.id],
    violations: [`${policy.id}: ${violation}`],
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
  return left.policy.id.localeCompare(right.policy.id);
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
