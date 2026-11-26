import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createBuiltInPolicyEngine,
  createRuleset,
  defineTypescriptRule,
} from "../../built-in-policy-engine-contract/src/built-in-policy-engine.js";
import { createFlagContract } from "../../flag-event-contract/src/flag-event-contract.js";

import {
  AUTO_REVERT_OBLIGATION_KIND,
  FLAG_CHANGE_ACTION,
  applyPolicyGatedFlagFlip,
  createDefaultFlagFlipRuleset,
  replayPolicyGatedFlagFlips,
} from "../src/policy-gated-flag-flips.js";

const NOW = "2026-06-26T04:00:00.000Z";
const actor = Object.freeze({
  kind: "user",
  id: "user-platform-admin",
  tenant: "tenant-a",
  claims: [{ key: "role", value: "flag-governor" }],
});

test("prod kill-switch flip requires approval before flag.Changed commits", async () => {
  const ref = createFlagContract().flag.boolean("checkout-kill-switch", { default: false }).ref;

  const blocked = await applyPolicyGatedFlagFlip({
    ref,
    from: false,
    to: true,
    actor,
    environment: "prod",
    killSwitch: true,
    time: NOW,
  });

  assert.equal(blocked.status, "blocked-pending-approval");
  assert.equal(blocked.committed, false);
  assert.equal(blocked.decision.effect, "require-approval");
  assert.deepEqual(
    blocked.events.map((event) => event.type),
    ["policy.Decided"],
  );

  const approved = await applyPolicyGatedFlagFlip({
    ref,
    from: false,
    to: true,
    actor,
    environment: "prod",
    killSwitch: true,
    time: NOW,
    approval: { approved: true, approvedBy: "user-platform-admin" },
  });

  assert.equal(approved.status, "committed");
  assert.deepEqual(
    approved.events.map((event) => event.type),
    ["policy.Decided", "flag.Changed"],
  );
  assert.equal(approved.events[1].data.policyDecisionId, approved.events[0].id);
});

test("risky percent bump creates auto-revert obligation and satisfies it on SLO burn", async () => {
  const ref = createFlagContract().flag.number("checkout-rollout-percent", { default: 0 }).ref;
  const sloBurnEvent = {
    id: "slo-burn-001",
    type: "slo.BudgetBurned",
    data: { burnRate: 15, window: "5m" },
  };

  const result = await applyPolicyGatedFlagFlip({
    ref,
    from: 0,
    to: 50,
    actor,
    environment: "prod",
    percentage: true,
    time: NOW,
    sloBurnEvent,
  });

  assert.equal(result.status, "committed-auto-reverted");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["policy.Decided", "flag.Changed", "policy.ObligationCreated", "flag.Changed", "policy.ObligationSatisfied"],
  );
  assert.equal(result.decision.obligations[0].kind, AUTO_REVERT_OBLIGATION_KIND);
  assert.equal(result.events[1].data.diff.value.to, 50);
  assert.equal(result.events[3].data.diff.value.to, 0);
  assert.equal(result.events[4].data.signalEventId, sloBurnEvent.id);
});

test("low-risk dev flip commits ungated", async () => {
  const ref = createFlagContract().flag.boolean("dev-banner", { default: false }).ref;

  const result = await applyPolicyGatedFlagFlip({
    ref,
    from: false,
    to: true,
    actor,
    environment: "dev",
    time: NOW,
  });

  assert.equal(result.status, "committed-ungated");
  assert.equal(result.decision, null);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["flag.Changed"],
  );
});

test("every gated commit is replay-joinable from policy.Decided to flag.Changed", async () => {
  const ref = createFlagContract().flag.number("checkout-rollout-percent", { default: 0 }).ref;

  const result = await applyPolicyGatedFlagFlip({
    ref,
    from: 0,
    to: 30,
    actor,
    environment: "prod",
    percentage: true,
    time: NOW,
  });
  const replay = replayPolicyGatedFlagFlips(result.events);

  assert.equal(replay.decisions.length, 1);
  assert.equal(replay.gatedChanges.length, 1);
  assert.equal(replay.gatedChanges[0].data.policyDecisionId, replay.decisions[0].id);
  assert.equal(
    replay.gatedChanges[0].data.policyDecisionInputHash,
    replay.decisions[0].data.evidence.inputHash,
  );
});

test("unsatisfied auto-revert obligation escalates instead of lapsing", async () => {
  const ref = createFlagContract().flag.number("checkout-rollout-percent", { default: 0 }).ref;

  const result = await applyPolicyGatedFlagFlip({
    ref,
    from: 0,
    to: 60,
    actor,
    environment: "prod",
    percentage: true,
    time: NOW,
    autoRevertAvailable: false,
    sloBurnEvent: {
      id: "slo-burn-002",
      type: "slo.BudgetBurned",
      data: { burnRate: 20, window: "5m" },
    },
  });

  assert.equal(result.status, "committed-obligation-escalated");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["policy.Decided", "flag.Changed", "policy.ObligationCreated", "policy.ObligationEscalated"],
  );
  assert.equal(result.events[3].data.reason, "auto-revert-unavailable");
});

test("rapid small percent bumps accumulate into risky velocity", async () => {
  const ref = createFlagContract().flag.number("checkout-rollout-percent", { default: 0 }).ref;

  const result = await applyPolicyGatedFlagFlip({
    ref,
    from: 30,
    to: 40,
    actor,
    environment: "prod",
    percentage: true,
    time: NOW,
    history: [
      { key: "checkout-rollout-percent", environment: "prod", percentage: true, from: 0, to: 10, time: "2026-06-26T03:55:00.000Z" },
      { key: "checkout-rollout-percent", environment: "prod", percentage: true, from: 10, to: 20, time: "2026-06-26T03:57:00.000Z" },
      { key: "checkout-rollout-percent", environment: "prod", percentage: true, from: 20, to: 30, time: "2026-06-26T03:59:00.000Z" },
    ],
  });

  assert.equal(result.status, "committed");
  assert.deepEqual(result.risk.reasons, ["cumulative-percent-velocity"]);
  assert.equal(result.risk.cumulativePercentDelta, 40);
  assert.equal(result.decision.obligations[0].kind, AUTO_REVERT_OBLIGATION_KIND);
});

test("deny effect blocks commit, and mutate effect changes committed value", async () => {
  const ref = createFlagContract().flag.number("checkout-rollout-percent", { default: 0 }).ref;
  const engine = createBuiltInPolicyEngine();
  const denyRuleset = createRuleset({
    id: "policy-pack:deny-flag-flips",
    version: "1.0.0",
    rules: [
      defineTypescriptRule({
        id: "deny-flag-change",
        when: ({ request }) => request.action === FLAG_CHANGE_ACTION,
        decide: () => ({ effect: "deny", reason: "freeze window" }),
      }),
    ],
  });

  const denied = await applyPolicyGatedFlagFlip({
    engine,
    ruleset: denyRuleset,
    ref,
    from: 0,
    to: 10,
    actor,
    environment: "prod",
    percentage: true,
    time: NOW,
  });

  assert.equal(denied.status, "denied");
  assert.deepEqual(
    denied.events.map((event) => event.type),
    ["policy.Decided"],
  );

  const mutateRuleset = createRuleset({
    id: "policy-pack:mutate-flag-flips",
    version: "1.0.0",
    rules: [
      defineTypescriptRule({
        id: "cap-rollout-percent",
        when: ({ request }) => request.action === FLAG_CHANGE_ACTION,
        decide: () => ({
          effect: "mutate",
          reason: "cap risky rollout at 25 percent",
          mutations: [{ kind: "flag.value.override", value: 25 }],
        }),
      }),
    ],
  });

  const mutated = await applyPolicyGatedFlagFlip({
    engine,
    ruleset: mutateRuleset,
    ref,
    from: 0,
    to: 60,
    actor,
    environment: "prod",
    percentage: true,
    time: NOW,
  });

  assert.equal(mutated.status, "committed");
  assert.equal(mutated.events[1].data.diff.value.to, 25);
});

test("default ruleset honors ordinary prod allow decisions", async () => {
  const ref = createFlagContract().flag.string("checkout-theme", { default: "control" }).ref;

  const result = await applyPolicyGatedFlagFlip({
    ref,
    from: "control",
    to: "treatment",
    actor,
    environment: "prod",
    ruleset: createDefaultFlagFlipRuleset(),
    time: NOW,
  });

  assert.equal(result.status, "committed");
  assert.equal(result.decision.effect, "allow");
  assert.equal(result.events[1].type, "flag.Changed");
});
