import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createFlagContract,
  createFlagArchived,
  createFlagChanged,
  createFlagEvaluated,
  replayFlagEvents,
  validateFlagEvent
} from "../src/flag-event-contract.js";

const actor = Object.freeze({
  kind: "user",
  id: "user_123",
  tenant: "tenant_a",
  claims: [{ key: "role", value: "deployer" }]
});

test("declaring a flag emits flag.Defined with type and default", () => {
  const contract = createFlagContract({
    knownTargetingAttributes: ["user.segment", "identity.tenant"]
  });

  const flag = contract.flag.boolean("new-checkout", {
    default: false,
    targeting: [{ attribute: "user.segment", op: "equals", value: "beta" }]
  });

  assert.deepEqual(flag.ref, {
    key: "new-checkout",
    type: "boolean"
  });
  assert.equal(flag.event.type, "flag.Defined");
  assert.equal(flag.event.version, 1);
  assert.equal(flag.event.data.key, "new-checkout");
  assert.equal(flag.event.data.valueType, "boolean");
  assert.equal(flag.event.data.defaultValue, false);
  assert.deepEqual(validateFlagEvent(flag.event), flag.event);
});

test("flag changes carry value diff and actor attribution", () => {
  const contract = createFlagContract();
  const declared = contract.flag.string("checkout-theme", { default: "control" });

  const changed = createFlagChanged(declared.ref, {
    from: "control",
    to: "treatment",
    actor,
    reason: "manual-rollout"
  });

  assert.equal(changed.type, "flag.Changed");
  assert.deepEqual(changed.actor, actor);
  assert.deepEqual(changed.data.diff, {
    value: {
      from: "control",
      to: "treatment"
    }
  });
  assert.equal(changed.data.reason, "manual-rollout");
  assert.deepEqual(validateFlagEvent(changed), changed);
});

test("replay reconstructs current flag state from flag events", () => {
  const contract = createFlagContract({
    knownTargetingAttributes: ["user.segment"]
  });
  const declared = contract.flag.number("rollout-percent", {
    default: 0,
    targeting: [{ attribute: "user.segment", op: "in", value: ["beta", "staff"] }]
  });
  const changed = createFlagChanged(declared.ref, {
    from: 0,
    to: 25,
    actor
  });

  const state = replayFlagEvents([declared.event, changed]);

  assert.deepEqual(state.flags["rollout-percent"], {
    key: "rollout-percent",
    valueType: "number",
    defaultValue: 0,
    currentValue: 25,
    targeting: [{ attribute: "user.segment", op: "in", value: ["beta", "staff"] }],
    archived: false
  });
});

test("flag.Evaluated is sampled opt-in and absent by default", () => {
  const contract = createFlagContract();
  const declared = contract.flag.object("checkout-layout", {
    default: { columns: 2 }
  });

  assert.equal(
    createFlagEvaluated(declared.ref, {
      value: { columns: 2 },
      reason: "static",
      actor
    }),
    null
  );

  const evaluated = createFlagEvaluated(declared.ref, {
    value: { columns: 3 },
    reason: "targeting-match",
    variant: "three-column",
    actor,
    sampled: true
  });

  assert.equal(evaluated.type, "flag.Evaluated");
  assert.equal(evaluated.data.sampled, true);
  assert.equal(evaluated.data.variant, "three-column");
  assert.deepEqual(validateFlagEvent(evaluated), evaluated);
});

test("flag.Archived validates and replays to archived state", () => {
  const contract = createFlagContract();
  const declared = contract.flag.boolean("stale-checkout", { default: false });
  const archived = createFlagArchived(declared.ref, {
    actor,
    reason: "stale-flag-cleanup"
  });

  assert.equal(archived.type, "flag.Archived");
  assert.equal(archived.data.reason, "stale-flag-cleanup");
  assert.deepEqual(validateFlagEvent(archived), archived);

  const state = replayFlagEvents([declared.event, archived]);
  assert.equal(state.flags["stale-checkout"].archived, true);
});

test("flag event streamId must match the flag key", () => {
  const contract = createFlagContract();
  const declared = contract.flag.boolean("new-checkout", { default: false });

  assert.throws(
    () => validateFlagEvent({ ...declared.event, streamId: "flag:other-key" }),
    /flag event streamId must match data key/
  );
});

test("flag.Changed without actor is rejected", () => {
  const contract = createFlagContract();
  const declared = contract.flag.boolean("kill-switch", { default: false });

  assert.throws(
    () => createFlagChanged(declared.ref, { from: false, to: true }),
    /flag\.Changed requires actor attribution/
  );
});

test("redefining a flag with a different type fails at collect time", () => {
  const contract = createFlagContract();

  contract.flag.boolean("new-checkout", { default: false });

  assert.throws(
    () => contract.flag.string("new-checkout", { default: "control" }),
    /cannot redefine flag new-checkout from boolean to string/
  );
});

test("targeting rules referencing unknown attributes fail at definition time", () => {
  const contract = createFlagContract({
    knownTargetingAttributes: ["user.segment"]
  });

  assert.throws(
    () =>
      contract.flag.boolean("new-checkout", {
        default: false,
        targeting: [{ attribute: "user.plan", op: "equals", value: "pro" }]
      }),
    /unknown targeting attribute user\.plan/
  );
});
