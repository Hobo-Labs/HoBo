import assert from "node:assert/strict";
import { test } from "vitest";

import {
  allPermutationsStable,
  assertNoYardDivergence,
  compareLateFederatedPack,
  makePack,
  simulateYard,
} from "../src/federated-policy-pack-conflict.js";

test("conflicting federated mandatory packs resolve to the union of denies on every Yard", () => {
  const packs = [
    makePack({
      id: "junction-security-baseline",
      scope: "junction",
      denies: ["hobo:provider:register:prod", "hobo:policy-pack:update:prod"],
    }),
    makePack({
      id: "yard-sovereign-baseline",
      scope: "yard",
      denies: ["region:outside-eu:prod", "secret:static-key:runtime"],
    }),
  ];

  const yardA = simulateYard({ yardId: "yard-a", packs });
  const yardB = simulateYard({ yardId: "yard-b", packs: packs.toReversed() });
  const result = assertNoYardDivergence([yardA, yardB]);

  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(
    yardA.effectiveDenySet.map((entry) => entry.tuple),
    [
      "hobo:policy-pack:update:prod",
      "hobo:provider:register:prod",
      "region:outside-eu:prod",
      "secret:static-key:runtime",
    ],
  );
});

test("attacker-controlled pack order cannot make one Yard more permissive", () => {
  const packs = [
    makePack({
      id: "z-bindle-local",
      scope: "bindle",
      denies: ["capability:storage.delete:runtime"],
    }),
    makePack({
      id: "a-junction-baseline",
      scope: "junction",
      denies: ["provider:unapproved:prod"],
    }),
    makePack({
      id: "m-yard-baseline",
      scope: "yard",
      denies: ["region:unapproved:prod"],
    }),
  ];

  const result = allPermutationsStable(packs);

  assert.equal(result.ok, true, "policy composition varied across permutations");
  assert.equal(result.checked, 6);
});

test("lower-scope allow attempting to widen a federated mandatory deny fails closed", () => {
  const parentPack = makePack({
    id: "junction-prod-baseline",
    scope: "junction",
    denies: ["hobo:delta:promote:prod"],
  });
  const wideningPack = makePack({
    id: "bindle-escape-hatch",
    scope: "bindle",
    allows: ["hobo:delta:promote:prod"],
  });

  const yard = simulateYard({
    yardId: "yard-with-escape-attempt",
    packs: [wideningPack, parentPack],
  });

  assert.equal(yard.ok, false);
  assert.match(yard.violations.join("\n"), /attempts to allow hobo:delta:promote:prod/);
  assert.deepEqual(
    yard.effectiveDenySet.map((entry) => entry.tuple),
    ["hobo:delta:promote:prod"],
  );
});

test("most-restrictive mandatory limit wins identically across federated packs", () => {
  const packs = [
    makePack({
      id: "junction-agent-cap",
      scope: "junction",
      limits: [{ key: "agent.maxSpendCents", maximum: 10000 }],
    }),
    makePack({
      id: "yard-agent-cap",
      scope: "yard",
      limits: [{ key: "agent.maxSpendCents", maximum: 2500 }],
    }),
    makePack({
      id: "camp-agent-cap",
      scope: "camp",
      limits: [{ key: "agent.maxSpendCents", maximum: 5000 }],
    }),
  ];

  const yardA = simulateYard({ yardId: "yard-a", packs });
  const yardB = simulateYard({ yardId: "yard-b", packs: packs.toReversed() });

  assert.equal(assertNoYardDivergence([yardA, yardB]).ok, true);
  assert.deepEqual(yardA.mandatoryLimits, [
    {
      key: "agent.maxSpendCents",
      maximum: 2500,
      source: "yard:yard-agent-cap/limit-1-agent-maxSpendCents",
    },
  ]);
});

test("late-arriving federated mandatory pack only adds denies and never relaxes", () => {
  const beforePacks = [
    makePack({
      id: "junction-baseline",
      scope: "junction",
      denies: ["provider:unapproved:prod"],
    }),
    makePack({
      id: "camp-baseline",
      scope: "camp",
      denies: ["secret:static-key:runtime"],
    }),
  ];
  const latePack = makePack({
    id: "yard-late-sovereign-rule",
    scope: "yard",
    denies: ["region:outside-eu:prod"],
  });

  const result = compareLateFederatedPack({ beforePacks, latePack });

  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.added, ["region:outside-eu:prod"]);
  assert.deepEqual(
    result.after.effectiveDenySet.map((entry) => entry.tuple),
    ["provider:unapproved:prod", "region:outside-eu:prod", "secret:static-key:runtime"],
  );
});
