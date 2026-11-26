import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createDecision,
  createDecisionRequest,
  POLICY_IR_SCHEMA_VERSION,
} from "../../hobo-policy-ir-contract/src/policy-ir.js";

import {
  createReferenceObligation,
  escalateOverdueObligations,
  evaluateObligationGate,
  recordObligationEffectCompleted,
  replayObligationEvents,
  satisfyObligation,
  startObligationsFromDecision,
} from "../src/obligation-engine.js";

const CREATED_AT = "2026-06-25T00:00:00.000Z";

test("decision obligations create tracked obligations that block until durable effect satisfaction", () => {
  const request = policyRequest();
  const obligation = createReferenceObligation("require-approval", {
    id: "obl-approval-prod",
    effectId: "effect-approval-prod",
    deadline: "2026-06-25T01:00:00.000Z",
  });
  const decision = createDecision(request, {
    effect: "require-approval",
    reason: "production deploy requires human approval",
    obligations: [obligation],
    evidence: {
      engine: "test-policy-engine",
      policyIds: ["policy:production-approval"],
    },
  });

  const created = startObligationsFromDecision({
    request,
    decision,
    at: CREATED_AT,
    idFactory: sequenceIds(),
  });
  const blocked = evaluateObligationGate(created.events);

  assert.deepEqual(
    created.events.map((event) => event.type),
    ["policy.ObligationCreated"],
  );
  assert.equal(blocked.blocked, true);
  assert.deepEqual(
    blocked.pending.map((entry) => entry.id),
    ["obl-approval-prod"],
  );

  const completed = recordObligationEffectCompleted({
    obligationId: "obl-approval-prod",
    effectId: "effect-approval-prod",
    result: { approverId: "user:sre-lead", decision: "approved" },
    at: "2026-06-25T00:10:00.000Z",
    idFactory: sequenceIds(2),
  });
  const satisfied = satisfyObligation({
    obligationId: "obl-approval-prod",
    effectId: "effect-approval-prod",
    at: "2026-06-25T00:11:00.000Z",
    idFactory: sequenceIds(3),
  });
  const replay = replayObligationEvents([...created.events, completed, satisfied]);
  const open = evaluateObligationGate([...created.events, completed, satisfied]);

  assert.equal(open.blocked, false);
  assert.deepEqual(
    open.satisfied.map((entry) => entry.id),
    ["obl-approval-prod"],
  );
  assert.equal(replay.ignoredEvents.length, 0);
  assert.deepEqual(
    replay.lifecycle.map((event) => event.type),
    [
      "policy.ObligationCreated",
      "policy.ObligationEffectCompleted",
      "policy.ObligationSatisfied",
    ],
  );
});

test("one ignored obligation keeps the gate blocked even when another obligation is satisfied", () => {
  const started = startDecision([
    createReferenceObligation("require-approval", {
      id: "obl-approval",
      effectId: "effect-approval",
    }),
    createReferenceObligation("require-canary", {
      id: "obl-canary",
      effectId: "effect-canary",
    }),
  ]);

  const approvalCompleted = recordObligationEffectCompleted({
    obligationId: "obl-approval",
    effectId: "effect-approval",
    result: { approverId: "user:sre-lead", decision: "approved" },
    at: "2026-06-25T00:05:00.000Z",
    idFactory: sequenceIds(20),
  });
  const approvalSatisfied = satisfyObligation({
    obligationId: "obl-approval",
    effectId: "effect-approval",
    at: "2026-06-25T00:06:00.000Z",
    idFactory: sequenceIds(30),
  });

  const gate = evaluateObligationGate([
    ...started.events,
    approvalCompleted,
    approvalSatisfied,
  ]);

  assert.equal(gate.blocked, true);
  assert.deepEqual(
    gate.satisfied.map((entry) => entry.id),
    ["obl-approval"],
  );
  assert.deepEqual(
    gate.pending.map((entry) => entry.id),
    ["obl-canary"],
  );
});

test("forged satisfied facts without the underlying effect completion do not unblock", () => {
  const started = startDecision([
    createReferenceObligation("require-approval", {
      id: "obl-forged",
      effectId: "effect-forged",
    }),
  ]);
  const forgedSatisfied = satisfyObligation({
    obligationId: "obl-forged",
    effectId: "effect-forged",
    at: "2026-06-25T00:01:00.000Z",
    idFactory: sequenceIds(40),
  });

  const gate = evaluateObligationGate([...started.events, forgedSatisfied]);

  assert.equal(gate.blocked, true);
  assert.deepEqual(
    gate.pending.map((entry) => entry.id),
    ["obl-forged"],
  );
  assert.deepEqual(
    gate.ignoredEvents.map((entry) => entry.reason),
    ["missing-durable-effect"],
  );
  assert.deepEqual(gate.satisfied, []);
});

test("deadline escalation emits a fact and never defaults an unrun effect to satisfied", () => {
  const started = startDecision([
    createReferenceObligation("auto-revert", {
      id: "obl-auto-revert",
      effectId: "effect-auto-revert",
      deadline: "2026-06-25T00:15:00.000Z",
    }),
  ]);
  const early = escalateOverdueObligations({
    events: started.events,
    at: "2026-06-25T00:14:59.000Z",
    idFactory: sequenceIds(50),
  });
  const overdue = escalateOverdueObligations({
    events: started.events,
    at: "2026-06-25T00:15:00.000Z",
    idFactory: sequenceIds(60),
  });

  assert.deepEqual(early.events, []);
  assert.deepEqual(
    overdue.events.map((event) => event.type),
    ["policy.ObligationEscalated"],
  );

  const gate = evaluateObligationGate([...started.events, ...overdue.events]);

  assert.equal(gate.blocked, true);
  assert.deepEqual(gate.satisfied, []);
  assert.deepEqual(
    gate.escalated.map((entry) => entry.id),
    ["obl-auto-revert"],
  );
  assert.deepEqual(
    gate.reasons.map((entry) => entry.reason),
    ["obligation-deadline-escalated"],
  );

  const duplicate = escalateOverdueObligations({
    events: [...started.events, ...overdue.events],
    at: "2026-06-25T00:16:00.000Z",
    idFactory: sequenceIds(70),
  });
  assert.deepEqual(duplicate.events, []);
});

test("reference obligation kinds map to durable effect contracts", () => {
  const approval = createReferenceObligation("require-approval");
  const canary = createReferenceObligation("require-canary");
  const autoRevert = createReferenceObligation("auto-revert");

  assert.deepEqual(approval.effect, {
    id: approval.effect.id,
    kind: "human-approval",
    contract: "hobo.effect.human-approval/v1",
  });
  assert.equal(canary.effect.kind, "rollout-canary");
  assert.equal(canary.effect.contract, "hobo.effect.rollout-canary/v1");
  assert.equal(autoRevert.effect.kind, "auto-revert-hook");
  assert.equal(autoRevert.effect.contract, "hobo.effect.auto-revert-hook/v1");
});

function startDecision(obligations) {
  const request = policyRequest();
  const decision = createDecision(request, {
    effect: "require-approval",
    reason: "policy requires durable obligation effects",
    obligations,
    evidence: {
      engine: "test-policy-engine",
      policyIds: ["policy:obligation-contract"],
    },
  });
  return startObligationsFromDecision({
    request,
    decision,
    at: CREATED_AT,
    idFactory: sequenceIds(10),
  });
}

function policyRequest() {
  return createDecisionRequest({
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: { kind: "agent", id: "agent:deployer" },
    action: "hobo:deployment.apply",
    resource: { kind: "deployment", id: "deploy:prod" },
    phase: "apply",
    context: { environment: "prod" },
  });
}

function sequenceIds(start = 1) {
  let nextId = start;
  return (prefix) => `${prefix}-${nextId++}`;
}
