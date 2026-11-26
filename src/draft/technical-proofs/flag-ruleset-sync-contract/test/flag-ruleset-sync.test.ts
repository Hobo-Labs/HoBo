import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createFlagChanged,
  createFlagContract
} from "../../flag-event-contract/src/flag-event-contract.js";
import { createFlagRulesetSync } from "../src/flag-ruleset-sync.js";

const actor = Object.freeze({
  kind: "user",
  id: "deployer_1",
  tenant: "tenant_a"
});

const betaContext = Object.freeze({
  user: {
    kind: "user",
    id: "user_123",
    tenant: "tenant_a",
    claims: [{ key: "segment", value: "beta" }]
  },
  identity: {
    kind: "service",
    id: "spiffe://tenant-a/camp/prod/bindle/checkout",
    tenant: "tenant_a",
    claims: []
  },
  attributes: []
});

function checkoutEvents() {
  const contract = createFlagContract({
    knownTargetingAttributes: ["user.segment"]
  });
  const defined = contract.flag.boolean("new-checkout", {
    default: false,
    targeting: [{ attribute: "user.segment", op: "equals", value: "beta" }]
  });
  const enabled = createFlagChanged(defined.ref, {
    from: false,
    to: true,
    actor,
    reason: "rollout"
  });
  const disabled = createFlagChanged(defined.ref, {
    from: true,
    to: false,
    actor,
    reason: "rollback"
  });

  return {
    defined: { seq: 1, event: defined.event },
    enabled: { seq: 2, event: enabled },
    disabled: { seq: 3, event: disabled }
  };
}

test("tails flag events and advances every subscribed evaluator to the latest seq", async () => {
  const { defined, enabled } = checkoutEvents();
  const sync = createFlagRulesetSync({ maxDeliveryMs: 50 });
  sync.subscribe("edge-a");
  sync.subscribe("edge-b");

  const firstDelivery = sync.append({ ...defined, emittedAtMs: 75 }, { nowMs: 100 });
  const secondDelivery = sync.append({ ...enabled, emittedAtMs: 100 }, { nowMs: 125 });

  assert.deepEqual(firstDelivery.delivered.map((delivery) => delivery.evaluatorId), [
    "edge-a",
    "edge-b"
  ]);
  assert.equal(sync.status("edge-a").seq, 2);
  assert.equal(sync.status("edge-b").seq, 2);
  assert.equal(sync.status("edge-a").freshness, "fresh");
  assert.deepEqual(
    secondDelivery.delivered.map((delivery) => delivery.deliveryMs),
    [25, 25]
  );

  const details = await sync.evaluateBoolean("edge-a", "new-checkout", false, betaContext);

  assert.equal(details.value, true);
  assert.equal(details.rulesetSeq, 2);
  assert.deepEqual(details.freshness, {
    status: "fresh",
    seq: 2,
    reason: "up-to-date"
  });
});

test("disconnected evaluators keep serving last-known rulesets with a stale label", async () => {
  const { defined, enabled, disabled } = checkoutEvents();
  const sync = createFlagRulesetSync();
  sync.subscribe("edge-a");
  sync.append(defined);
  sync.append(enabled);
  sync.disconnect("edge-a", "stream-disconnected");

  sync.append(disabled);
  const details = await sync.evaluateBoolean("edge-a", "new-checkout", false, betaContext);

  assert.equal(details.value, true);
  assert.equal(details.rulesetSeq, 2);
  assert.deepEqual(details.freshness, {
    status: "stale",
    seq: 2,
    reason: "stream-disconnected"
  });
});

test("reconnect resyncs from snapshot plus tail to the latest seq", async () => {
  const { defined, enabled, disabled } = checkoutEvents();
  const sync = createFlagRulesetSync();
  sync.subscribe("edge-a");
  sync.append(defined);
  sync.disconnect("edge-a", "stream-disconnected");
  sync.append(enabled);
  sync.append(disabled);

  const resync = sync.reconnect("edge-a", { snapshotSeq: 2 });
  const details = await sync.evaluateBoolean("edge-a", "new-checkout", true, betaContext);

  assert.deepEqual(resync, {
    evaluatorId: "edge-a",
    snapshotSeq: 2,
    tailSeq: 3,
    seq: 3,
    freshness: "fresh"
  });
  assert.equal(details.value, false);
  assert.equal(details.rulesetSeq, 3);
  assert.deepEqual(sync.status("edge-a").ruleset, sync.fullReplayRuleset());
});

test("out-of-order delivery never regresses an evaluator below its current seq", () => {
  const { defined, enabled } = checkoutEvents();
  const sync = createFlagRulesetSync();
  sync.subscribe("edge-a");
  sync.append(defined);
  sync.append(enabled);

  const staleDelivery = sync.deliverTo("edge-a", defined);

  assert.deepEqual(staleDelivery, {
    evaluatorId: "edge-a",
    ignored: true,
    reason: "stale-delivery",
    currentSeq: 2,
    deliveredSeq: 1
  });
  assert.equal(sync.status("edge-a").seq, 2);
});

test("slow evaluators do not stall delivery to healthy evaluators", async () => {
  const { defined, enabled } = checkoutEvents();
  const sync = createFlagRulesetSync();
  sync.subscribe("fast-edge");
  sync.subscribe("slow-edge");
  sync.setBackpressured("slow-edge", true);

  const delivery = sync.append(defined);
  sync.append(enabled);

  assert.deepEqual(delivery.backpressured, ["slow-edge"]);
  assert.equal(sync.status("fast-edge").seq, 2);
  assert.equal(sync.status("slow-edge").seq, 0);
  assert.equal(sync.status("slow-edge").freshness, "stale");

  sync.drain("slow-edge");

  assert.equal(sync.status("slow-edge").seq, 2);
  assert.equal(sync.status("slow-edge").freshness, "fresh");
  assert.equal(
    (await sync.evaluateBoolean("slow-edge", "new-checkout", false, betaContext)).value,
    true
  );
});

test("local evaluation performs no per-eval network call", async () => {
  const { defined, enabled } = checkoutEvents();
  const sync = createFlagRulesetSync();
  sync.subscribe("edge-a");
  sync.append(defined);
  sync.append(enabled);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("per-eval network calls are forbidden");
  };

  try {
    const details = await sync.evaluateBoolean("edge-a", "new-checkout", false, betaContext);
    assert.equal(details.value, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
