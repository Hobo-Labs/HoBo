# HOBO-192 Cost/Quota Policy Input Proof

This proof extends `src/draft/technical-proofs/budget-quota-policy-contract` for the M2 policy
input slice described by [Plan 29](../../contracts-policy-flags.md#plan-29) and
[ADR-0039](../../adr/02-identity-security.md#adr-0039).

## Acceptance Evidence

- Soft threshold crossing yields an allow decision with `spend.warn-threshold`
  in `budget-quota-policy.test.ts`.
- Hard quota crossing denies spend-incurring actions at the policy gate.
- Reservation-required policies consume a synchronous pre-commit quota
  reservation and deny the next hot-loop attempt when the fenced counter has an
  existing in-flight reservation, bounding overshoot to one reserved action.
- Spend velocity crossing a `costAvailabilityProfile` tier returns
  `allow-degraded` and emits a durable `spend.degradation-required` obligation.
- A spend-incurring action with no matching scoped `MeteringView` quota counter
  fails closed instead of treating an unrelated policy as unlimited context.
- Every branch outcome is wrapped by the audited `policy.Decided` event.

## Scope Guard

This POC does not implement the MeteringView projection, spend event producers,
planner objectives, SRE operator, breaker reset mechanics, or runtime degraded
execution levers. It only proves the policy input and decision contract.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\budget-quota-policy-contract test
npm.cmd test
```
