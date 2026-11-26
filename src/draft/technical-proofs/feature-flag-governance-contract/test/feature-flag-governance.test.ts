import assert from "node:assert/strict";
import { test } from "vitest";

import {
  evaluateFeatureFlagChangeGovernance,
  fireAutoRevertObligations
} from "../src/feature-flag-governance.js";

const actor = Object.freeze({
  kind: "user",
  id: "user-platform-admin",
  tenant: "tenant-a"
});

test("prod kill-switch flip requires approval and emits policy.Decided", async () => {
  const events = [];

  const decision = await evaluateFeatureFlagChangeGovernance({
    change: {
      actor,
      environment: "prod",
      flagKey: "checkout.kill-switch",
      operation: "kill-switch",
      valueType: "boolean",
      from: false,
      to: true
    },
    auditSink: (event) => events.push(event)
  });

  assert.equal(decision.effect, "require-approval");
  assert.deepEqual(decision.approvals, [
    {
      kind: "feature-flag.prod-kill-switch",
      environment: "prod",
      flagKey: "checkout.kill-switch"
    }
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "policy.Decided");
  assert.equal(events[0].data.effect, "require-approval");
});

test("risky prod percentage bump carries durable auto-revert obligation", async () => {
  const events = [];

  const decision = await evaluateFeatureFlagChangeGovernance({
    change: {
      actor,
      environment: "prod",
      flagKey: "checkout.rollout",
      operation: "percentage-rollout",
      percentage: {
        from: 10,
        to: 55
      },
      valueType: "number",
      from: 10,
      to: 55
    },
    auditSink: (event) => events.push(event)
  });

  assert.equal(decision.effect, "require-approval");
  assert.deepEqual(decision.obligations, [
    {
      kind: "feature-flag.auto-revert-on-slo-burn",
      durable: true,
      environment: "prod",
      flagKey: "checkout.rollout",
      trigger: {
        type: "slo.Burned"
      },
      revert: {
        from: 55,
        to: 10
      }
    }
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "policy.Decided");
  assert.equal(events[0].data.effect, "require-approval");
});

test("low-risk dev flip is ungated", async () => {
  const decision = await evaluateFeatureFlagChangeGovernance({
    change: {
      actor,
      environment: "dev",
      flagKey: "checkout.debug-banner",
      operation: "value-change",
      valueType: "boolean",
      from: false,
      to: true
    }
  });

  assert.equal(decision.effect, "allow");
  assert.deepEqual(decision.approvals, []);
  assert.deepEqual(decision.obligations, []);
});

test("auto-revert obligation fires on simulated SLO burn signal", async () => {
  const decision = await evaluateFeatureFlagChangeGovernance({
    change: {
      actor,
      environment: "prod",
      flagKey: "checkout.rollout",
      operation: "percentage-rollout",
      percentage: {
        from: 10,
        to: 55
      },
      valueType: "number",
      from: 10,
      to: 55
    }
  });

  const events = fireAutoRevertObligations({
    decision,
    signal: {
      type: "slo.Burned",
      environment: "prod",
      flagKey: "checkout.rollout",
      burnRate: 3
    }
  });

  assert.deepEqual(events, [
    {
      type: "flag.RevertRequested",
      streamId: "flag:checkout.rollout",
      data: {
        environment: "prod",
        flagKey: "checkout.rollout",
        from: 55,
        to: 10,
        reason: "slo-burn-auto-revert",
        obligationKind: "feature-flag.auto-revert-on-slo-burn"
      }
    }
  ]);
});

test("prod kill-switch remains gated when caller claims low risk", async () => {
  const decision = await evaluateFeatureFlagChangeGovernance({
    change: {
      actor,
      claimedRisk: "low",
      environment: "prod",
      flagKey: "checkout.kill-switch",
      operation: "kill-switch",
      valueType: "boolean",
      from: false,
      to: true
    }
  });

  assert.equal(decision.effect, "require-approval");
  assert.equal(decision.approvals[0].kind, "feature-flag.prod-kill-switch");
});

test("attempt to flip a prod flag while bypassing the policy gate is denied", async () => {
  const decision = await evaluateFeatureFlagChangeGovernance({
    change: {
      actor,
      bypassPolicyGate: true,
      environment: "prod",
      flagKey: "checkout.debug-banner",
      operation: "value-change",
      valueType: "boolean",
      from: false,
      to: true
    }
  });

  assert.equal(decision.effect, "deny");
  assert.deepEqual(decision.violations, [
    "prod feature-flag changes must be evaluated through the policy gate"
  ]);
});

test("prod flip during evaluator outage fails closed", async () => {
  const events = [];

  const decision = await evaluateFeatureFlagChangeGovernance({
    change: {
      actor,
      environment: "prod",
      evaluator: {
        available: false,
        failurePolicy: "fail-closed"
      },
      flagKey: "checkout.debug-banner",
      operation: "value-change",
      valueType: "boolean",
      from: false,
      to: true
    },
    auditSink: (event) => events.push(event)
  });

  assert.equal(decision.effect, "deny");
  assert.deepEqual(decision.violations, [
    "flag evaluator unavailable; fail-closed policy denies prod flip"
  ]);
  assert.equal(events[0].type, "policy.Decided");
  assert.equal(events[0].data.effect, "deny");
});
