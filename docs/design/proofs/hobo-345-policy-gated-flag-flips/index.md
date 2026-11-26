# HOBO-345 Policy-gated flag flips proof

This proof pins the contract for policy-gated `flag.Changed` commits:

- Prod kill-switch flips emit `policy.Decided` with `require-approval`; no `flag.Changed` is emitted
  until an approval is present.
- Risky percentage changes emit `policy.Decided`, commit `flag.Changed`, create a durable
  `policy.ObligationCreated`, and satisfy the obligation with an auto-revert `flag.Changed` when an
  injected `slo.BudgetBurned` event arrives.
- Low-risk dev flips commit directly as ungated `flag.Changed` events.
- Gated commits carry `policyDecisionId` and `policyDecisionInputHash`, so replay can join every
  `flag.Changed` to the exact `policy.Decided` event.
- Negative vectors cover approval never arriving, unsatisfied auto-revert obligations escalating, and
  cumulative percent velocity catching split risky bumps.

The executable package lives at:

```text
src/draft/technical-proofs/policy-gated-flag-flips-contract
```

Verification:

```sh
npm test -- src/draft/technical-proofs/policy-gated-flag-flips-contract/test/policy-gated-flag-flips.test.ts
```

Scope intentionally excludes the policy engine internals, RBAC who-may-flip decisions, SLO burn
signal production, and shared rollout auto-revert mechanics.
