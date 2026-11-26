import assert from "node:assert/strict";
import { test } from "vitest";

import { POLICY_IR_SCHEMA_VERSION } from "../../hobo-policy-ir-contract/src/policy-ir.js";

import {
  LIFECYCLE_PHASE_POLICY_ENGINE_ID,
  createLifecyclePhaseRuleset,
  createStarterLifecycleRuleset,
  definePhaseRule,
  evaluateLifecyclePhasePolicy,
} from "../src/lifecycle-phase-policy.js";

function request(overrides = {}) {
  return {
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: {
      kind: "agent",
      id: "agent:swe-operator",
      roles: ["Operator-Supervisor"],
      scopes: ["source.write"],
      delegatedBy: "user:platform-admin",
      ...overrides.subject,
    },
    action: overrides.action ?? "lifecycle.fixture",
    resource: overrides.resource ?? { kind: "policy-fixture", id: "fixture" },
    phase: overrides.phase ?? "author",
    context: overrides.context ?? {},
  };
}

const STARTER_PHASE_FIXTURES = [
  {
    phase: "author",
    expectedEffect: "deny",
    request: request({
      phase: "author",
      action: "handler.publish",
      resource: { kind: "handler", id: "checkout.public" },
      context: { publicHandler: true, inputSchemaDeclared: false },
    }),
  },
  {
    phase: "local",
    expectedEffect: "deny",
    request: request({
      phase: "local",
      action: "source.scan",
      resource: { kind: "source", id: "checkout" },
      context: { hardcodedSecrets: ["DATABASE_URL"] },
    }),
  },
  {
    phase: "test",
    expectedEffect: "deny",
    request: request({
      phase: "test",
      action: "test.run",
      resource: { kind: "contract", id: "external-stripe" },
      context: { externalInteractions: [{ target: "stripe", contract: null }] },
    }),
  },
  {
    phase: "plan",
    expectedEffect: "deny",
    request: request({
      phase: "plan",
      action: "deployment.plan",
      resource: { kind: "data-resource", id: "orders-db" },
      context: { environment: "prod", encrypted: true, backedUp: false },
    }),
  },
  {
    phase: "apply",
    expectedEffect: "require-approval",
    request: request({
      phase: "apply",
      action: "resource.delete",
      resource: { kind: "database", id: "orders-prod" },
      context: { environment: "prod", approval: null },
    }),
  },
  {
    phase: "runtime",
    expectedEffect: "deny",
    request: request({
      phase: "runtime",
      action: "agent.tool.call",
      resource: { kind: "agent-tool", id: "source-write" },
      context: {
        tool: { name: "write_source", scope: "source.write" },
        runtimeDelegatedScopes: [],
      },
    }),
  },
  {
    phase: "observe",
    expectedEffect: "deny",
    request: request({
      phase: "observe",
      action: "trace.store",
      resource: { kind: "trace", id: "run-1" },
      context: { traceContainsPii: true },
    }),
  },
  {
    phase: "train",
    expectedEffect: "deny",
    request: request({
      phase: "train",
      action: "trajectory.train",
      resource: { kind: "trajectory", id: "run-1" },
      context: { dataClassifications: ["pii"] },
    }),
  },
  {
    phase: "promote",
    expectedEffect: "deny",
    request: request({
      phase: "promote",
      action: "semantic.implementation.promote",
      resource: { kind: "semantic-function", id: "recommend" },
      context: { candidateScore: 0.7, championScore: 0.8 },
    }),
  },
  {
    phase: "repair",
    expectedEffect: "deny",
    request: request({
      phase: "repair",
      action: "agent.repair.auto-fix",
      resource: { kind: "deployment", id: "checkout-prod" },
      context: { environment: "prod" },
    }),
  },
];

test("starter lifecycle pack routes each request only to the matching phase rule", () => {
  const ruleset = createStarterLifecycleRuleset();

  for (const fixture of STARTER_PHASE_FIXTURES) {
    const result = evaluateLifecyclePhasePolicy({ request: fixture.request, ruleset });

    assert.equal(result.decision.effect, fixture.expectedEffect, fixture.phase);
    assert.equal(result.request.phase, fixture.phase);
    assert.equal(result.phaseEvidence.phase, fixture.phase);
    assert.deepEqual(result.phaseEvidence.matchedRuleIds, [`starter.${fixture.phase}`]);
    assert.equal(result.auditEvent.type, "policy.Decided");
    assert.equal(result.auditEvent.phase, fixture.phase);
    assert.equal(result.auditEvent.audit.phase, fixture.phase);
    assert.equal(result.decision.evidence.engine, LIFECYCLE_PHASE_POLICY_ENGINE_ID);
  }
});

test("rule scoped to apply does not leak into author phase", () => {
  const ruleset = createLifecyclePhaseRuleset({
    rules: [
      definePhaseRule({
        id: "apply.delete-prod",
        phases: ["apply"],
        when: ({ request: candidate }) => candidate.action === "resource.delete",
        decide: () => ({ effect: "require-approval", reason: "prod delete needs approval" }),
      }),
    ],
  });

  const result = evaluateLifecyclePhasePolicy({
    request: request({
      phase: "author",
      action: "resource.delete",
      resource: { kind: "database", id: "orders-prod" },
      context: { environment: "prod" },
    }),
    ruleset,
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.reason, /no lifecycle phase rule matched/);
  assert.deepEqual(result.phaseEvidence.matchedRuleIds, []);
});

test("unknown lifecycle phase fails closed instead of defaulting permissive", () => {
  const result = evaluateLifecyclePhasePolicy({
    request: request({ phase: "superuser" }),
    ruleset: createStarterLifecycleRuleset(),
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.reason, /request validation failed/);
  assert.match(result.decision.violations.join("\n"), /unknown-phase/);
  assert.equal(result.phaseEvidence.phase, null);
});

test("runtime phase denies author-allowed action without runtime delegated scope", () => {
  const result = evaluateLifecyclePhasePolicy({
    request: request({
      phase: "runtime",
      action: "agent.tool.call",
      resource: { kind: "agent-tool", id: "source-write" },
      context: {
        authorTimeAllowed: true,
        tool: { name: "write_source", scope: "source.write" },
        runtimeDelegatedScopes: [],
      },
    }),
    ruleset: createStarterLifecycleRuleset(),
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.reason, /runtime delegated scope/);
});

test("runtime phase denies tool calls that omit required scope evidence", () => {
  const result = evaluateLifecyclePhasePolicy({
    request: request({
      phase: "runtime",
      action: "agent.tool.call",
      resource: { kind: "agent-tool", id: "unscoped-tool" },
      context: {
        runtimeDelegatedScopes: ["source.write"],
      },
    }),
    ruleset: createStarterLifecycleRuleset(),
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.reason, /missing required delegated scope/);
});

test("promote phase denies candidates without finite score evidence", () => {
  const result = evaluateLifecyclePhasePolicy({
    request: request({
      phase: "promote",
      action: "semantic.implementation.promote",
      resource: { kind: "semantic-function", id: "recommend" },
      context: { candidateScore: "not-a-number", championScore: 0.8 },
    }),
    ruleset: createStarterLifecycleRuleset(),
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.reason, /score evidence/);
});

test("repair phase allows preview auto-fix but blocks prod auto-fix as propose-only", () => {
  const ruleset = createStarterLifecycleRuleset();
  const preview = evaluateLifecyclePhasePolicy({
    request: request({
      phase: "repair",
      action: "agent.repair.auto-fix",
      resource: { kind: "deployment", id: "checkout-preview" },
      context: { environment: "preview" },
    }),
    ruleset,
  });
  const prod = evaluateLifecyclePhasePolicy({
    request: request({
      phase: "repair",
      action: "agent.repair.auto-fix",
      resource: { kind: "deployment", id: "checkout-prod" },
      context: { environment: "prod" },
    }),
    ruleset,
  });

  assert.equal(preview.decision.effect, "allow");
  assert.equal(prod.decision.effect, "deny");
  assert.match(prod.decision.violations.join("\n"), /propose-only/);
});
