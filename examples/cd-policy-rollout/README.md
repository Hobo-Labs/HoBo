# Rail rollout: inform, then enforce

This example ships a policy change the same way you ship code (plan 0024,
D24, D25, I22, I23, R12). The Rail `rail-eu-storage` gains a rule that
denies public buckets.

- **Rail Freight.** Approving the new Rail version on the Station creates
  Freight with subject `RAIL`, discovered through the `HOBO_RAIL`
  subscription.
- **`shadow` (INFORM).** The new Rail is bound as each Camp's *candidate*.
  The enforced Rail still makes every decision. The gate also evaluates the
  candidate and records `policy.ShadowDecided`, with divergence, and posture
  evaluates it. The node qualifies only when the noncompliant ratio stays at
  or below 2 % and shadow divergence stays within the declared count (1 here,
  because the Rail is meant to block one thing) over 24 h. No data fails.
- **`enforce` (ENFORCE).** This node reads only from `shadow`, needs an
  approval, and runs only in EU business hours. Promotion makes the new Rail
  the enforced one. Rollback restores the previous digest through the gate,
  and windows always allow it.
- **Posture.** `storage-baseline` is bound `inform`. `eu-residency` is
  `inform-only`, so a parent binding can never raise it to `enforce`.
  Enforcement, where it is bound, acts only through repair Deltas that the
  Camp's reconciler applies (I22).

## Run

```sh
pnpm --filter @hobo/example-cd-policy-rollout test
hobo deploy pipeline apply --file examples/cd-policy-rollout/src/hobo.delivery.ts
hobo deploy compliance show <camp>
hobo deploy promote <rail-freight> --pipeline rail-eu-storage --node enforce
```

## Runbook

- **`enforce` is refused with `shadow-required`.** The Rail has no qualified
  INFORM node upstream, or its approval expired. Let `shadow` run its 24 h
  verification first (I23).
- **`shadow` fails verification on divergence.** The candidate changed more
  decisions than it declared. Read the `policy.ShadowDecided` records. Either
  fix the Rail or raise `EXPECTED_DIVERGENCES` in a reviewed change, so the
  impact is acknowledged explicitly.
- **A Camp reports `ownership-conflict`.** A posture rule contradicts a value
  the Set owns. Nothing is mutated, and promotions that keep the violation are
  refused until the declaration changes (I22).
- **Roll back the Rail.** `hobo deploy rollback --camp <camp>` restores the
  previous enforced digest through the gate. Windows always allow it.
