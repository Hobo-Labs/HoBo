import assert from "node:assert/strict";
import { test } from "vitest";

import {
  allowRule,
  canonicalJson,
  composePolicyPacks,
  definePolicyPack,
  denyRule,
  isScopeMonotonic,
  limitRule
} from "../src/deny-ceiling-algebra.js";

test("two simulated Yards produce the same effective deny-set from the same packs", () => {
  const packs = [
    definePolicyPack({
      id: "org-baseline",
      scope: "junction",
      rules: [denyRule({ id: "no-preview-prod", tuple: "interface.preview:prod" })]
    }),
    definePolicyPack({
      id: "yard-eu",
      scope: "yard",
      rules: [denyRule({ id: "eu-residency", tuple: "region:non-eu:prod" })]
    }),
    definePolicyPack({
      id: "bindle-checkout",
      scope: "bindle",
      rules: [denyRule({ id: "no-delete", tuple: "capability:storage.delete:runtime" })]
    })
  ];

  const yardA = composePolicyPacks(packs);
  const yardB = composePolicyPacks([packs[2], packs[0], packs[1]]);

  assert.equal(yardA.ok, true, yardA.violations.join("\n"));
  assert.equal(yardB.ok, true, yardB.violations.join("\n"));
  assert.equal(canonicalJson(yardA.effectiveDenySet), canonicalJson(yardB.effectiveDenySet));
});

test("scope monotonicity keeps parent mandatory denies when a child adds restrictions", () => {
  const parent = composePolicyPacks([
    definePolicyPack({
      id: "org-baseline",
      scope: "junction",
      rules: [denyRule({ id: "no-egress", tuple: "integration:external-egress:prod" })]
    })
  ]);
  const child = composePolicyPacks([
    definePolicyPack({
      id: "org-baseline",
      scope: "junction",
      rules: [denyRule({ id: "no-egress", tuple: "integration:external-egress:prod" })]
    }),
    definePolicyPack({
      id: "checkout-camp",
      scope: "camp",
      rules: [denyRule({ id: "no-static-keys", tuple: "secret:static-key:runtime" })]
    })
  ]);

  assert.equal(isScopeMonotonic(parent, child), true);
  assert.deepEqual(
    child.effectiveDenySet.map((entry) => entry.tuple),
    ["integration:external-egress:prod", "secret:static-key:runtime"]
  );
});

test("conflicting federated mandatory packs resolve to the union of denies regardless of order", () => {
  const packA = definePolicyPack({
    id: "security-defaults",
    scope: "junction",
    rules: [denyRule({ id: "no-unapproved-provider", tuple: "provider:unapproved:prod" })]
  });
  const packB = definePolicyPack({
    id: "sovereign-defaults",
    scope: "junction",
    rules: [denyRule({ id: "eu-only", tuple: "region:non-eu:prod" })]
  });

  const first = composePolicyPacks([packA, packB]);
  const second = composePolicyPacks([packB, packA]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(
    first.effectiveDenySet.map((entry) => entry.tuple),
    ["provider:unapproved:prod", "region:non-eu:prod"]
  );
  assert.equal(canonicalJson(first.effectiveDenySet), canonicalJson(second.effectiveDenySet));
});

test("default rules are overridable but mandatory deny-ceilings are rejected when widened", () => {
  const defaultOverride = composePolicyPacks([
    definePolicyPack({
      id: "junction-recommendation",
      scope: "junction",
      rules: [denyRule({ id: "prefer-no-preview", mode: "default", tuple: "interface.preview:staging" })]
    }),
    definePolicyPack({
      id: "camp-preview",
      scope: "camp",
      rules: [allowRule({ id: "allow-preview-staging", tuple: "interface.preview:staging" })]
    })
  ]);
  const mandatoryWiden = composePolicyPacks([
    definePolicyPack({
      id: "junction-prod",
      scope: "junction",
      rules: [denyRule({ id: "no-preview-prod", tuple: "interface.preview:prod" })]
    }),
    definePolicyPack({
      id: "bindle-escape",
      scope: "bindle",
      rules: [allowRule({ id: "allow-preview-prod", tuple: "interface.preview:prod" })]
    })
  ]);

  assert.equal(defaultOverride.ok, true, defaultOverride.violations.join("\n"));
  assert.deepEqual(defaultOverride.effectiveDenySet, []);
  assert.equal(mandatoryWiden.ok, false);
  assert.match(mandatoryWiden.violations.join("\n"), /attempts to allow interface\.preview:prod/);
  assert.deepEqual(
    mandatoryWiden.effectiveDenySet.map((entry) => entry.tuple),
    ["interface.preview:prod"]
  );
});

test("same-scope rule ordering cannot hide a mandatory widening attempt", () => {
  const composed = composePolicyPacks([
    definePolicyPack({
      id: "junction-prod",
      scope: "junction",
      rules: [
        allowRule({ id: "a-allow-preview", tuple: "interface.preview:prod" }),
        denyRule({ id: "z-deny-preview", tuple: "interface.preview:prod" })
      ]
    })
  ]);

  assert.equal(composed.ok, false);
  assert.match(composed.violations.join("\n"), /attempts to allow interface\.preview:prod/);
  assert.deepEqual(
    composed.effectiveDenySet.map((entry) => entry.tuple),
    ["interface.preview:prod"]
  );
});

test("most restrictive mandatory limit wins deterministically", () => {
  const composed = composePolicyPacks([
    definePolicyPack({
      id: "org-agent-cap",
      scope: "junction",
      rules: [limitRule({ id: "agent-spend-100", key: "agent.maxSpendCents", maximum: 10000 })]
    }),
    definePolicyPack({
      id: "yard-agent-cap",
      scope: "yard",
      rules: [limitRule({ id: "agent-spend-20", key: "agent.maxSpendCents", maximum: 2000 })]
    })
  ]);

  assert.equal(composed.ok, true);
  assert.deepEqual(composed.mandatoryLimits, [
    {
      key: "agent.maxSpendCents",
      maximum: 2000,
      source: "yard:yard-agent-cap/agent-spend-20"
    }
  ]);
});

test("malicious input order cannot change outcome", () => {
  const packs = [
    definePolicyPack({
      id: "b-camp",
      scope: "camp",
      rules: [denyRule({ id: "camp-deny", tuple: "capability:delete:runtime" })]
    }),
    definePolicyPack({
      id: "a-junction",
      scope: "junction",
      rules: [denyRule({ id: "junction-deny", tuple: "provider:unapproved:prod" })]
    }),
    definePolicyPack({
      id: "a-camp",
      scope: "camp",
      rules: [denyRule({ id: "camp-deny", tuple: "region:non-eu:prod" })]
    })
  ];

  const canonical = canonicalJson(composePolicyPacks(packs).effectiveDenySet);
  for (const permutation of permutations(packs)) {
    assert.equal(canonicalJson(composePolicyPacks(permutation).effectiveDenySet), canonical);
  }
});

function permutations(values) {
  if (values.length <= 1) {
    return [values];
  }
  return values.flatMap((value, index) =>
    permutations(values.toSpliced(index, 1)).map((tail) => [value, ...tail])
  );
}
