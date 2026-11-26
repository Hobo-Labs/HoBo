import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "vitest";

import {
  createFlagChanged,
  createFlagContract
} from "../../flag-event-contract/src/flag-event-contract.js";
import {
  createBuiltInFlagProvider,
  createBuiltInFlagStore
} from "../src/built-in-flag-store.js";
import { isJsonNumber } from "../src/json.js";

const actor = Object.freeze({
  kind: "user",
  id: "user_123",
  tenant: "tenant_a"
});

const betaUser = Object.freeze({
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

const controlUser = Object.freeze({
  user: {
    kind: "user",
    id: "user_456",
    tenant: "tenant_a",
    claims: [{ key: "segment", value: "control" }]
  },
  attributes: []
});

test("evaluates a flag deterministically from the event-sourced built-in store", async () => {
  const contract = createFlagContract({
    knownTargetingAttributes: ["user.segment"]
  });
  const declared = contract.flag.boolean("new-checkout", {
    default: false,
    targeting: [{ attribute: "user.segment", op: "equals", value: "beta" }]
  });
  const changed = createFlagChanged(declared.ref, {
    from: false,
    to: true,
    actor
  });

  const store = createBuiltInFlagStore([
    { seq: 1, event: declared.event },
    { seq: 2, event: changed }
  ]);
  const provider = store.providerAt(2);

  const first = await provider.getBooleanDetails("new-checkout", false, betaUser);
  const second = await provider.getBooleanDetails("new-checkout", false, betaUser);
  const control = await provider.getBooleanDetails("new-checkout", false, controlUser);

  assert.equal(first.value, true);
  assert.equal(first.reason, "targeting-match");
  assert.equal(first.variant, "on");
  assert.equal(isJsonNumber(first.bucket), true);
  assert.deepEqual(second, first);
  assert.equal(control.value, false);
  assert.equal(control.reason, "default");
});

test("pins evaluation to the requested ruleset seq", async () => {
  const contract = createFlagContract();
  const declared = contract.flag.boolean("kill-switch", { default: false });
  const changed = createFlagChanged(declared.ref, {
    from: false,
    to: true,
    actor
  });
  const store = createBuiltInFlagStore([
    { seq: 1, event: declared.event },
    { seq: 2, event: changed }
  ]);

  const beforeChange = await store.providerAt(1).getBooleanDetails(
    "kill-switch",
    false,
    betaUser
  );
  const afterChange = await store.providerAt(2).getBooleanDetails(
    "kill-switch",
    false,
    betaUser
  );

  assert.equal(beforeChange.value, false);
  assert.equal(beforeChange.rulesetSeq, 1);
  assert.equal(afterChange.value, true);
  assert.equal(afterChange.rulesetSeq, 2);
  assert.deepEqual(
    await store.providerAt(1).getBooleanDetails("kill-switch", false, betaUser),
    beforeChange
  );
});

test("exposes the four OpenFeature value types through the in-process provider", async () => {
  const contract = createFlagContract();
  const enabled = contract.flag.boolean("checkout-enabled", { default: true });
  const theme = contract.flag.string("checkout-theme", { default: "compact" });
  const weight = contract.flag.number("checkout-weight", { default: 0.25 });
  const layout = contract.flag.object("checkout-layout", {
    default: { columns: 2, density: "tight" }
  });
  const provider = createBuiltInFlagStore([
    { seq: 1, event: enabled.event },
    { seq: 2, event: theme.event },
    { seq: 3, event: weight.event },
    { seq: 4, event: layout.event }
  ]).providerAt(4);

  assert.equal(await provider.getBooleanValue("checkout-enabled", false, betaUser), true);
  assert.equal(await provider.getStringValue("checkout-theme", "wide", betaUser), "compact");
  assert.equal(await provider.getNumberValue("checkout-weight", 0, betaUser), 0.25);
  assert.deepEqual(await provider.getObjectValue("checkout-layout", {}, betaUser), {
    columns: 2,
    density: "tight"
  });
});

test("offline evaluation performs no network fetches", async () => {
  const contract = createFlagContract();
  const declared = contract.flag.boolean("offline-mode", { default: true });
  const provider = createBuiltInFlagStore([{ seq: 1, event: declared.event }]).providerAt(1);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network access is forbidden during flag evaluation");
  };

  try {
    assert.equal(await provider.getBooleanValue("offline-mode", false, betaUser), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("per-flag buckets are stable across unrelated flag changes and processes", async () => {
  const contract = createFlagContract();
  const declared = contract.flag.boolean("new-checkout", { default: false });
  const changed = createFlagChanged(declared.ref, { from: false, to: true, actor });
  const unrelated = contract.flag.boolean("unrelated-flag", { default: true });
  const store = createBuiltInFlagStore([
    { seq: 1, event: declared.event },
    { seq: 2, event: changed },
    { seq: 3, event: unrelated.event }
  ]);

  const beforeUnrelated = await store.providerAt(2).getBooleanDetails(
    "new-checkout",
    false,
    betaUser
  );
  const afterUnrelated = await store.providerAt(3).getBooleanDetails(
    "new-checkout",
    false,
    betaUser
  );
  const childBucket = Number(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
          import { createBuiltInFlagProvider } from ${JSON.stringify(new URL("../src/built-in-flag-store.js", import.meta.url).href)};
          const provider = createBuiltInFlagProvider({
            seq: 2,
            flags: {
              "new-checkout": {
                key: "new-checkout",
                valueType: "boolean",
                defaultValue: false,
                currentValue: true,
                targeting: []
              }
            }
          });
          const details = await provider.getBooleanDetails("new-checkout", false, {
            user: { id: "user_123" }
          });
          console.log(details.bucket);
        `
      ],
      { encoding: "utf8" }
    ).trim()
  );

  assert.equal(beforeUnrelated.bucket, afterUnrelated.bucket);
  assert.equal(beforeUnrelated.bucket, childBucket);
});

test("empty context misses targeting and returns the caller default", async () => {
  const contract = createFlagContract({
    knownTargetingAttributes: ["user.segment"]
  });
  const declared = contract.flag.boolean("requires-user-segment", {
    default: false,
    targeting: [{ attribute: "user.segment", op: "equals", value: "beta" }]
  });
  const changed = createFlagChanged(declared.ref, { from: false, to: true, actor });
  const provider = createBuiltInFlagStore([
    { seq: 1, event: declared.event },
    { seq: 2, event: changed }
  ]).providerAt(2);

  const details = await provider.getBooleanDetails("requires-user-segment", false, {});

  assert.equal(details.value, false);
  assert.equal(details.reason, "default");
  assert.equal(details.variant, "default");
});

test("malformed ruleset entries fail safe to the caller default", async () => {
  const provider = createBuiltInFlagProvider({
    seq: 7,
    flags: {
      "broken-flag": {
        key: "broken-flag",
        valueType: "boolean",
        defaultValue: false,
        currentValue: "yes",
        targeting: []
      }
    }
  });

  const details = await provider.getBooleanDetails("broken-flag", false, betaUser);

  assert.equal(details.value, false);
  assert.equal(details.reason, "error");
  assert.deepEqual(details.error, {
    code: "malformed-ruleset",
    message: "broken-flag has invalid boolean value at ruleset seq 7"
  });
  assert.equal(details.rulesetSeq, 7);
});
