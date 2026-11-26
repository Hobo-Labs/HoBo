import {
  allowRule,
  canonicalJson,
  composePolicyPacks,
  definePolicyPack,
  denyRule,
  limitRule,
} from "../../deny-ceiling-algebra-poc/src/deny-ceiling-algebra.js";

export const FEDERATED_POLICY_CONFLICT_SCHEMA =
  "hobo.federated-policy-pack-conflict/v1";

export function makePack({ id, scope, denies = [], allows = [], limits = [] }) {
  return definePolicyPack({
    id,
    scope,
    rules: [
      ...denies.map((tuple, index) =>
        denyRule({ id: `deny-${index + 1}-${slug(tuple)}`, tuple }),
      ),
      ...allows.map((tuple, index) =>
        allowRule({ id: `allow-${index + 1}-${slug(tuple)}`, tuple }),
      ),
      ...limits.map((limit, index) =>
        limitRule({
          id: `limit-${index + 1}-${slug(limit.key)}`,
          key: limit.key,
          maximum: limit.maximum,
        }),
      ),
    ],
  });
}

export function simulateYard({ yardId, packs }) {
  const composition = composePolicyPacks(packs);
  return {
    schema: FEDERATED_POLICY_CONFLICT_SCHEMA,
    yardId,
    ok: composition.ok,
    errors: composition.errors,
    violations: composition.violations,
    effectiveDenySet: composition.effectiveDenySet,
    mandatoryLimits: composition.mandatoryLimits,
    fingerprint: canonicalJson({
      effectiveDenySet: composition.effectiveDenySet,
      mandatoryLimits: composition.mandatoryLimits,
      ok: composition.ok,
      violations: composition.violations,
    }),
  };
}

export function assertNoYardDivergence(yards) {
  if (!Array.isArray(yards) || yards.length < 2) {
    throw new TypeError("at least two Yard simulations are required");
  }

  const [first, ...rest] = yards;
  const divergent = rest.find((yard) => yard.fingerprint !== first.fingerprint);
  if (divergent) {
    return {
      ok: false,
      reason: `${divergent.yardId} diverged from ${first.yardId}`,
      yards,
    };
  }

  return {
    ok: true,
    reason: "all Yards computed the same mandatory deny ceiling",
    yards,
  };
}

export function allPermutationsStable(packs) {
  const baseline = simulateYard({ yardId: "baseline", packs }).fingerprint;
  const divergent = permutations(packs).find(
    (permutation) =>
      simulateYard({ yardId: "permutation", packs: permutation }).fingerprint !== baseline,
  );
  return {
    ok: !divergent,
    checked: permutations(packs).length,
    baseline,
  };
}

export function compareLateFederatedPack({ beforePacks, latePack }) {
  const before = simulateYard({ yardId: "before-late-pack", packs: beforePacks });
  const after = simulateYard({
    yardId: "after-late-pack",
    packs: [...beforePacks, latePack],
  });

  const beforeDenies = new Set(before.effectiveDenySet.map((entry) => entry.tuple));
  const afterDenies = new Set(after.effectiveDenySet.map((entry) => entry.tuple));
  const removed = [...beforeDenies].filter((tuple) => !afterDenies.has(tuple));
  const added = [...afterDenies].filter((tuple) => !beforeDenies.has(tuple));

  return {
    ok: after.ok && removed.length === 0,
    before,
    after,
    added,
    removed,
  };
}

function permutations(values) {
  if (values.length <= 1) {
    return [values];
  }
  return values.flatMap((value, index) =>
    permutations(values.toSpliced(index, 1)).map((tail) => [value, ...tail]),
  );
}

function slug(value) {
  return String(value).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}
