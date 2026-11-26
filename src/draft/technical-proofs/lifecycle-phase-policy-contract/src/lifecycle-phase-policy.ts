import {
  PHASES,
  POLICY_IR_SCHEMA_VERSION,
  createDecision,
  createDecisionRequest,
  createPolicyDecidedEvent,
} from "../../hobo-policy-ir-contract/src/policy-ir.js";
import { isJsonString, isJsonObject } from "./json.js";


export const LIFECYCLE_PHASE_POLICY_SCHEMA_VERSION = "hobo.lifecycle-phase-policy/v1";
export const LIFECYCLE_PHASE_RULESET_SCHEMA_VERSION = "hobo.lifecycle-phase-ruleset/v1";
export const LIFECYCLE_PHASE_POLICY_ENGINE_ID = "hobo.lifecycle-phase-policy/contract@0.1.0";

const PHASE_SET = new Set(PHASES);
const EFFECT_RANK = new Map([
  ["deny", 0],
  ["require-approval", 1],
  ["mutate", 2],
  ["allow-degraded", 3],
  ["warn", 4],
  ["allow", 5],
]);

export function definePhaseRule({ id, phases, when, decide }) {
  return {
    id,
    phases: [...phases],
    when,
    decide,
  };
}

export function createLifecyclePhaseRuleset({
  id = "lifecycle-phase-ruleset",
  version = "1.0.0",
  rules = [],
} = {}) {
  return {
    schemaVersion: LIFECYCLE_PHASE_RULESET_SCHEMA_VERSION,
    id,
    version,
    rules: [...rules],
  };
}

export function createStarterLifecycleRuleset() {
  return createLifecyclePhaseRuleset({
    id: "starter-lifecycle-phase-pack",
    rules: [
      definePhaseRule({
        id: "starter.author",
        phases: ["author"],
        when: ({ request }) => request.action === "handler.publish" && request.context.publicHandler === true,
        decide: ({ request }) =>
          request.context.inputSchemaDeclared === true
            ? allow("author public handler declares an input schema")
            : deny("author public handler must declare an input schema", [
                "public handler missing input schema",
              ]),
      }),
      definePhaseRule({
        id: "starter.local",
        phases: ["local"],
        when: ({ request }) => request.action === "source.scan",
        decide: ({ request }) => {
          const secrets = arrayOfStrings(request.context.hardcodedSecrets);
          return secrets.length === 0
            ? allow("local source scan found no hardcoded secrets")
            : deny("local source scan found hardcoded secrets", secrets.map((secret) => `${secret} is hardcoded`));
        },
      }),
      definePhaseRule({
        id: "starter.test",
        phases: ["test"],
        when: ({ request }) => request.action === "test.run",
        decide: ({ request }) => {
          const missing = (Array.isArray(request.context.externalInteractions)
            ? request.context.externalInteractions
            : []
          ).filter((interaction) => !interaction?.contract);
          return missing.length === 0
            ? allow("test external interactions have contracts")
            : deny("test external interactions need contracts", missing.map((item) => `${item.target ?? "external"} missing contract`));
        },
      }),
      definePhaseRule({
        id: "starter.plan",
        phases: ["plan"],
        when: ({ request }) =>
          request.action === "deployment.plan" &&
          (request.resource.kind === "data-resource" || request.context.environment === "prod"),
        decide: ({ request }) => {
          const missing = [];
          if (request.context.encrypted !== true) {
            missing.push("prod data resource missing encryption");
          }
          if (request.context.backedUp !== true) {
            missing.push("prod data resource missing backup");
          }
          return missing.length === 0 ? allow("plan data resource protection passed") : deny("plan data protection failed", missing);
        },
      }),
      definePhaseRule({
        id: "starter.apply",
        phases: ["apply"],
        when: ({ request }) =>
          request.action === "resource.delete" && request.context.environment === "prod",
        decide: ({ request }) =>
          request.context.approval
            ? allow("apply prod delete has approval")
            : {
                effect: "require-approval",
                reason: "apply prod resource deletion requires approval",
                approvals: [{ kind: "approval.required", resourceId: request.resource.id }],
                obligations: [
                  {
                    kind: "policy.approval.required",
                    reason: "prod deletion needs approval",
                    resourceId: request.resource.id,
                  },
                ],
              },
      }),
      definePhaseRule({
        id: "starter.runtime",
        phases: ["runtime"],
        when: ({ request }) => request.action === "agent.tool.call",
        decide: ({ request }) => {
          const requiredScope = requiredToolScope(request);
          const runtimeScopes = arrayOfStrings(request.context.runtimeDelegatedScopes);
          const subjectScopes = arrayOfStrings(request.subject.scopes);
          if (!requiredScope) {
            return deny("runtime tool call missing required delegated scope", [
              "tool.scope or requiredScope must be declared",
            ]);
          }
          if (runtimeScopes.includes(requiredScope)) {
            return allow("runtime delegated scope permits tool call");
          }
          const authorNote = request.context.authorTimeAllowed ? " despite author-time allowance" : "";
          return deny(`runtime delegated scope missing${authorNote}`, [
            `${requiredScope} not present in runtimeDelegatedScopes`,
            subjectScopes.includes(requiredScope)
              ? "subject has broader author-time scope, but runtime phase requires delegated runtime scope"
              : `${requiredScope} not present in subject scopes`,
          ]);
        },
      }),
      definePhaseRule({
        id: "starter.observe",
        phases: ["observe"],
        when: ({ request }) => request.action === "trace.store",
        decide: ({ request }) =>
          request.context.traceContainsPii === true
            ? deny("observe trace contains PII", ["PII must be redacted before trace storage"])
            : allow("observe trace has no PII"),
      }),
      definePhaseRule({
        id: "starter.train",
        phases: ["train"],
        when: ({ request }) => request.action === "trajectory.train",
        decide: ({ request }) => {
          const classifications = arrayOfStrings(request.context.dataClassifications);
          return request.context.traceContainsPii === true || classifications.includes("pii")
            ? deny("train trajectory contains PII", ["PII-bearing traces cannot train"])
            : allow("train trajectory passed data classification gate");
        },
      }),
      definePhaseRule({
        id: "starter.promote",
        phases: ["promote"],
        when: ({ request }) => request.action === "semantic.implementation.promote",
        decide: ({ request }) => {
          const candidateScore = Number(request.context.candidateScore);
          const championScore = Number(request.context.championScore);
          if (!Number.isFinite(candidateScore) || !Number.isFinite(championScore)) {
            return deny("promote score evidence missing or invalid", [
              "candidateScore and championScore must be finite numbers",
            ]);
          }
          if (request.context.guardrailCoverageRegression === true) {
            return deny("promote candidate regresses guardrail coverage", ["contract lens failed"]);
          }
          if (candidateScore <= championScore) {
            return deny("promote candidate did not beat champion", ["eval lens failed"]);
          }
          return allow("promote candidate beat champion and preserved contracts");
        },
      }),
      definePhaseRule({
        id: "starter.repair",
        phases: ["repair"],
        when: ({ request }) => request.action === "agent.repair.auto-fix",
        decide: ({ request }) =>
          request.context.environment === "prod"
            ? deny("repair prod changes are propose-only", ["prod repair auto-fix denied; propose-only required"])
            : allow("repair preview auto-fix permitted"),
      }),
    ],
  });
}

export function evaluateLifecyclePhasePolicy({ request: requestInput, ruleset = createStarterLifecycleRuleset() }) {
  let request;
  try {
    request = createDecisionRequest(requestInput);
  } catch (error) {
    return invalidRequestResult(requestInput, error);
  }

  const compiled = compileRuleset(ruleset);
  if (!compiled.ok) {
    return resultForDecision({
      request,
      decision: createDecision(request, {
        effect: "deny",
        reason: `ruleset compile failed: ${ruleset?.id ?? "unknown"}`,
        violations: compiled.errors,
        evidence: { policyIds: [], engine: LIFECYCLE_PHASE_POLICY_ENGINE_ID },
      }),
      matchedRuleIds: [],
    });
  }

  const matched = [];
  for (const rule of compiled.rules) {
    if (!rule.phases.includes(request.phase)) {
      continue;
    }
    let shouldEvaluate;
    try {
      shouldEvaluate = rule.when({ request });
    } catch (error) {
      return resultForDecision({
        request,
        decision: createDecision(request, {
          effect: "deny",
          reason: `phase rule evaluation failed: ${rule.id}`,
          violations: [`${rule.id}: ${error.message}`],
          evidence: { policyIds: [rule.id], engine: LIFECYCLE_PHASE_POLICY_ENGINE_ID },
        }),
        matchedRuleIds: [rule.id],
      });
    }
    if (!shouldEvaluate) {
      continue;
    }
    const partial = rule.decide({ request });
    if (!partial || !isJsonObject(partial) || Array.isArray(partial) || !EFFECT_RANK.has(partial.effect)) {
      return resultForDecision({
        request,
        decision: createDecision(request, {
          effect: "deny",
          reason: `phase rule evaluation failed: ${rule.id}`,
          violations: [`${rule.id}: decision effect is invalid`],
          evidence: { policyIds: [rule.id], engine: LIFECYCLE_PHASE_POLICY_ENGINE_ID },
        }),
        matchedRuleIds: [rule.id],
      });
    }
    matched.push({ rule, partial });
  }

  if (matched.length === 0) {
    return resultForDecision({
      request,
      decision: createDecision(request, {
        effect: "deny",
        reason: `deny-by-default: no lifecycle phase rule matched ${request.phase}`,
        violations: [`no lifecycle phase rule matched ${request.action} during ${request.phase}`],
        evidence: { policyIds: [], engine: LIFECYCLE_PHASE_POLICY_ENGINE_ID },
      }),
      matchedRuleIds: [],
    });
  }

  const ordered = matched.toSorted((left, right) => left.rule.id.localeCompare(right.rule.id));
  const winning = matched.toSorted(compareMatchedPartials).at(0);
  const decision = createDecision(request, {
    effect: winning.partial.effect,
    reason: winning.partial.reason,
    violations: ordered.flatMap(({ partial }) => partial.violations ?? []),
    mutations: ordered.flatMap(({ partial }) => partial.mutations ?? []),
    approvals: ordered.flatMap(({ partial }) => partial.approvals ?? []),
    obligations: ordered.flatMap(({ partial }) => partial.obligations ?? []),
    evidence: {
      policyIds: ordered.map(({ rule }) => rule.id),
      engine: LIFECYCLE_PHASE_POLICY_ENGINE_ID,
    },
  });

  return resultForDecision({
    request,
    decision,
    matchedRuleIds: ordered.map(({ rule }) => rule.id),
  });
}

function compileRuleset(ruleset) {
  const errors = [];
  if (!ruleset || !isJsonObject(ruleset) || Array.isArray(ruleset)) {
    return { ok: false, errors: ["ruleset must be an object"], rules: [] };
  }
  if (ruleset.schemaVersion !== LIFECYCLE_PHASE_RULESET_SCHEMA_VERSION) {
    errors.push(`ruleset.schemaVersion must be ${LIFECYCLE_PHASE_RULESET_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(ruleset.id)) {
    errors.push("ruleset.id must be a non-empty string");
  }
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(ruleset.version ?? "")) {
    errors.push("ruleset.version must be semver");
  }
  if (!Array.isArray(ruleset.rules)) {
    errors.push("ruleset.rules must be an array");
    return { ok: false, errors, rules: [] };
  }

  const ids = new Set();
  for (const [index, rule] of ruleset.rules.entries()) {
    validateRule(rule, index, ids, errors);
  }

  return {
    ok: errors.length === 0,
    errors,
    rules: errors.length === 0 ? ruleset.rules.toSorted((left, right) => left.id.localeCompare(right.id)) : [],
  };
}

function validateRule(rule, index, ids, errors) {
  const path = `rules[${index}]`;
  if (!rule || !isJsonObject(rule) || Array.isArray(rule)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!isNonEmptyString(rule.id)) {
    errors.push(`${path}.id must be a non-empty string`);
  } else if (ids.has(rule.id)) {
    errors.push(`${rule.id}: duplicate rule id`);
  } else {
    ids.add(rule.id);
  }
  if (!Array.isArray(rule.phases) || rule.phases.length === 0) {
    errors.push(`${rule.id ?? path}.phases must be a non-empty array`);
  } else {
    for (const phase of rule.phases) {
      if (!PHASE_SET.has(phase)) {
        errors.push(`${rule.id ?? path}.phases contains unknown phase ${String(phase)}`);
      }
    }
  }
  if (!(rule.when instanceof Function)) {
    errors.push(`${rule.id ?? path}.when must be a function`);
  }
  if (!(rule.decide instanceof Function)) {
    errors.push(`${rule.id ?? path}.decide must be a function`);
  }
}

function invalidRequestResult(requestInput, error) {
  const request = createDecisionRequest({
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: {
      kind: "system",
      id: "lifecycle-phase-policy",
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
  const decision = createDecision(request, {
    effect: "deny",
    reason: "request validation failed",
    violations: [`${error.code ?? error.name}: ${error.message}`],
    evidence: {
      policyIds: [],
      engine: LIFECYCLE_PHASE_POLICY_ENGINE_ID,
    },
  });
  const base = resultForDecision({ request, decision, matchedRuleIds: [] });
  return {
    ...base,
    phaseEvidence: {
      phase: null,
      matchedRuleIds: [],
      inputHash: request.inputHash,
      engine: LIFECYCLE_PHASE_POLICY_ENGINE_ID,
    },
  };
}

function resultForDecision({ request, decision, matchedRuleIds }) {
  const auditEvent = {
    ...createPolicyDecidedEvent({ request, decision }),
    audit: {
      phase: request.phase,
      matchedRuleIds,
      engine: LIFECYCLE_PHASE_POLICY_ENGINE_ID,
    },
  };

  return {
    schemaVersion: LIFECYCLE_PHASE_POLICY_SCHEMA_VERSION,
    request,
    decision,
    phaseEvidence: {
      phase: request.phase,
      matchedRuleIds,
      inputHash: request.inputHash,
      engine: LIFECYCLE_PHASE_POLICY_ENGINE_ID,
    },
    auditEvent,
  };
}

function compareMatchedPartials(left, right) {
  const effectCompare = EFFECT_RANK.get(left.partial.effect) - EFFECT_RANK.get(right.partial.effect);
  if (effectCompare !== 0) {
    return effectCompare;
  }
  return left.rule.id.localeCompare(right.rule.id);
}

function allow(reason) {
  return { effect: "allow", reason };
}

function deny(reason, violations) {
  return { effect: "deny", reason, violations };
}

function requiredToolScope(request) {
  if (isJsonString(request.context.tool?.scope)) {
    return request.context.tool.scope;
  }
  if (isJsonString(request.context.requiredScope)) {
    return request.context.requiredScope;
  }
  return null;
}

function arrayOfStrings(input) {
  return Array.isArray(input) ? input.filter((value) => isJsonString(value)) : [];
}

function isNonEmptyString(input) {
  return isJsonString(input) && input.trim().length > 0;
}

function safeJson(input) {
  try {
    return JSON.parse(JSON.stringify(input ?? null));
  } catch {
    return null;
  }
}
