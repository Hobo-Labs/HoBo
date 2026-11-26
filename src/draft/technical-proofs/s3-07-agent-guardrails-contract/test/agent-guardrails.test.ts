import assert from "node:assert/strict";
import { test } from "vitest";

import { POLICY_IR_SCHEMA_VERSION } from "../../hobo-policy-ir-contract/src/policy-ir.js";

import {
  AGENT_GUARDRAILS_ENGINE_ID,
  canAgentProceed,
  classifyActionClass,
  evaluateAgentGuardrail,
  rebuildAgentGuardrailState,
} from "../src/agent-guardrails.js";

function decisionRequest(overrides = {}) {
  return {
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: {
      kind: "agent",
      id: "agent:tenant-a/agent-deploy",
      delegatedBy: "user:platform-admin",
      roles: ["deployer"],
      scopes: ["hobo:deployment:apply"],
    },
    action: "hobo:deployment:apply",
    resource: {
      kind: "deployment",
      id: "deployment:checkout-prod",
    },
    phase: "apply",
    context: {
      owner: {
        tenantId: "tenant-a",
        campId: "camp-prod",
        agentId: "agent-deploy",
      },
      actorId: "user:platform-admin",
      environment: "prod",
      costEstimateUsd: 0,
      correlationId: "corr-633",
      occurredAt: "2026-07-01T12:00:00.000Z",
      ...overrides.context,
    },
    ...overrides,
  };
}

function agentPolicy(overrides = {}) {
  return {
    agentId: "tenant-a/agent-deploy",
    actionClasses: {
      read: "auto-allow",
      write: "require-approval",
      deploy: "require-approval",
      destroy: "deny",
      token: "require-approval",
      admin: "deny",
    },
    spendCapUsd: 50,
    allowedApprovers: ["user:platform-admin", "user:finance-admin"],
    destroyGrant: { granted: false, grantId: null },
    ...overrides,
  };
}

function meteringView(scopeCosts = {}, seq = 10) {
  return { seq, scopeCosts };
}

function obligationSatisfied(overrides = {}) {
  return {
    type: "policy.ObligationSatisfied",
    seq: 3,
    occurredAt: "2026-07-01T12:05:00.000Z",
    correlationId: "corr-633",
    data: {
      id: "approval:tenant-a/agent-deploy:hobo:deployment:apply",
      effectRef: "agent-guardrail:tenant-a/agent-deploy:hobo:deployment:apply",
      agentId: "tenant-a/agent-deploy",
      action: "hobo:deployment:apply",
      approverId: "user:platform-admin",
      ...overrides,
    },
  };
}

test("classifyActionClass maps gateway and runtime actions consistently", () => {
  assert.equal(classifyActionClass("hobo:deployment:destroy"), "destroy");
  assert.equal(classifyActionClass("hobo:resource.delete"), "destroy");
  assert.equal(classifyActionClass("hobo:deployment:apply"), "deploy");
  assert.equal(classifyActionClass("hobo:deployment:get"), "read");
  assert.equal(classifyActionClass("hobo:token:request"), "token");
});

test("high-risk deploy blocks on policy gate until human approval with event-sourced decisions", () => {
  const blocked = evaluateAgentGuardrail({
    request: decisionRequest(),
    policy: agentPolicy(),
    enforcementPoint: "gateway",
  });

  assert.equal(blocked.decision.effect, "require-approval");
  assert.equal(blocked.actionClass, "deploy");
  assert.deepEqual(blocked.events.map((event) => event.type), [
    "policy.Decided",
    "agent.GuardrailBlocked",
  ]);
  assert.equal(blocked.events[0].data.evidence.engine, AGENT_GUARDRAILS_ENGINE_ID);
  assert.equal(canAgentProceed(blocked.events).canProceed, false);

  const approved = evaluateAgentGuardrail({
    request: decisionRequest(),
    policy: agentPolicy(),
    enforcementPoint: "runtime",
    approval: {
      decision: "approved",
      approverId: "user:platform-admin",
      approvedAt: "2026-07-01T12:01:00.000Z",
    },
  });

  assert.equal(approved.decision.effect, "allow");
  assert.equal(approved.events[1].type, "agent.GuardrailCleared");
  assert.equal(canAgentProceed(approved.events).canProceed, true);

  const satisfied = [
    ...blocked.events,
    obligationSatisfied(),
  ];
  assert.equal(canAgentProceed(satisfied).canProceed, true);
  const rebuilt = rebuildAgentGuardrailState(satisfied);
  assert.equal(rebuilt.policyDecision.effect, "require-approval");
  assert.equal(rebuilt.canProceed, false);
});

test("spend-over-cap deploy halts with require-approval instead of silent spend", () => {
  const halted = evaluateAgentGuardrail({
    request: decisionRequest({
      action: "hobo:deployment:apply",
      context: { costEstimateUsd: 12 },
    }),
    policy: agentPolicy({
      actionClasses: {
        read: "auto-allow",
        write: "auto-allow",
        deploy: "auto-allow",
        destroy: "deny",
        token: "require-approval",
        admin: "deny",
      },
      spendCapUsd: 30,
    }),
    meteringView: meteringView({
      "agent:tenant-a/agent-deploy": { cost: 25 },
    }),
  });

  assert.equal(halted.decision.effect, "require-approval");
  assert.match(halted.decision.reason, /spendCapUsd/);
  assert.equal(
    halted.events.some((event) => event.type === "spend.CapGateEvaluated"),
    true,
  );
  assert.equal(canAgentProceed(halted.events).canProceed, false);

  const approved = evaluateAgentGuardrail({
    request: decisionRequest({
      action: "hobo:deployment:apply",
      context: { costEstimateUsd: 12 },
    }),
    policy: agentPolicy({
      actionClasses: {
        read: "auto-allow",
        write: "auto-allow",
        deploy: "auto-allow",
        destroy: "deny",
        token: "require-approval",
        admin: "deny",
      },
      spendCapUsd: 30,
    }),
    meteringView: meteringView({
      "agent:tenant-a/agent-deploy": { cost: 25 },
    }),
    approval: {
      decision: "approved",
      approverId: "user:finance-admin",
      approvedAt: "2026-07-01T12:02:00.000Z",
    },
  });

  assert.equal(approved.decision.effect, "allow");
  assert.equal(approved.decision.approvals[0].approverId, "user:finance-admin");
});

test("destroy without explicit grant is denied with auditable policy.Decided", () => {
  const denied = evaluateAgentGuardrail({
    request: decisionRequest({
      action: "hobo:deployment:destroy",
      resource: { kind: "deployment", id: "deployment:checkout-prod" },
    }),
    policy: agentPolicy({
      actionClasses: {
        read: "auto-allow",
        write: "auto-allow",
        deploy: "auto-allow",
        destroy: "auto-allow",
        token: "auto-allow",
        admin: "auto-allow",
      },
      destroyGrant: { granted: false, grantId: null },
    }),
  });

  assert.equal(denied.decision.effect, "deny");
  assert.match(denied.decision.reason, /destroy denied without explicit grant/);
  assert.equal(
    denied.events.some((event) => event.type === "agent.DestroyDenied"),
    true,
  );
  assert.equal(canAgentProceed(denied.events).canProceed, false);
});

test("destroy proceeds only with explicit grant recorded on policy or request context", () => {
  const granted = evaluateAgentGuardrail({
    request: decisionRequest({
      action: "hobo:deployment:destroy",
      context: {
        destroyGrant: { granted: true, grantId: "grant:checkout-prod-destroy" },
      },
    }),
    policy: agentPolicy({
      actionClasses: {
        read: "auto-allow",
        write: "auto-allow",
        deploy: "auto-allow",
        destroy: "auto-allow",
        token: "auto-allow",
        admin: "auto-allow",
      },
    }),
  });

  assert.equal(granted.decision.effect, "allow");
  assert.equal(granted.events[1].type, "agent.GuardrailCleared");
});

test("adversarial: forged approval obligation does not release a blocked high-risk action", () => {
  const blocked = evaluateAgentGuardrail({
    request: decisionRequest(),
    policy: agentPolicy(),
  });

  const forged = [
    ...blocked.events,
    obligationSatisfied({
      id: "approval:other-agent",
      effectRef: "agent-guardrail:other-agent:hobo:deployment:apply",
      agentId: "tenant-a/other-agent",
      action: "hobo:deployment:destroy",
    }),
  ];

  assert.equal(canAgentProceed(forged).canProceed, false);
});

test("adversarial: denied action class stays denied even with approval present", () => {
  const denied = evaluateAgentGuardrail({
    request: decisionRequest({ action: "hobo:admin:impersonate" }),
    policy: agentPolicy(),
    approval: {
      decision: "approved",
      approverId: "user:platform-admin",
      approvedAt: "2026-07-01T12:03:00.000Z",
    },
  });

  assert.equal(denied.decision.effect, "deny");
  assert.match(denied.decision.reason, /admin actions are denied/);
});

test("adversarial: read actions auto-allow without approval when spend cap is not exceeded", () => {
  const allowed = evaluateAgentGuardrail({
    request: decisionRequest({
      action: "hobo:deployment:get",
      context: { costEstimateUsd: 0 },
    }),
    policy: agentPolicy(),
  });

  assert.equal(allowed.decision.effect, "allow");
  assert.equal(allowed.events[1].type, "agent.GuardrailCleared");
});
