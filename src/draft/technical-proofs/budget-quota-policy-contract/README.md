# Budget/Quota Policy Contract POC

Independent POC for HOBO-290, extended for HOBO-192. It pins the M2 cost-safety gate between
`MeteringView` and the policy plane without implementing the policy engine,
showback UI, SRE operator, or cost-plane projections.

## Contract Surface

- `evaluateBudgetQuotaPolicy({ request, meteringView, policies, approval, reservation })`
  consumes a policy `DecisionRequest` and a seq-pinned `MeteringView` snapshot.
- Camp and tenant budgets support soft and hard USD thresholds.
- Agent `spendCapUsd` is treated as the same quota gate, with explicit approve
  or deny handling.
- `reservation` is optional for legacy policies, but required when a policy sets
  `reservationRequired: true`; it carries the fenced counter id, matching scope,
  granted/denied result, reserved USD amount, and in-flight action id.
- Decisions return a policy IR decision plus an auditable `policy.Decided`
  event and supporting `spend.*` budget/cap facts.

## Scope Boundaries

Included:

- Soft budget crossing yields an allow decision with a warning obligation.
- Hard budget crossing denies spend-incurring deployment and agent-provision
  gates.
- Agent spend-cap crossing requires approval, honors approved/denied outcomes,
  and records approver evidence.
- Estimate-vs-actual overspend is marked as reconciliation-required without
  implementing the reconciliation engine.
- Reservation-required policies consume synchronous pre-commit quota
  reservations and deny missing, mismatched, denied, or under-sized
  reservations before an action runs.
- Spend-incurring actions fail closed when the policy input lacks a matching
  scoped `MeteringView` quota counter; an unrelated quota policy is not treated
  as unlimited context.
- Spend-velocity crossing a `costAvailabilityProfile` tier returns
  `allow-degraded` with a durable `spend.degradation-required` obligation.
- Out-of-order `MeteringView` updates fail closed.
- Partial-provision hard denies carry a compensation obligation.

Excluded:

- Policy-engine implementation or rule authoring.
- MeteringView projection, `spend.*` event production by the cost plane, and
  planner objectives.
- Runtime enforcement levers for degraded execution.
- Spend-velocity circuit breaker reset mechanics and `spend.CircuitTripped`.
- Showback presentation or billing/chargeback.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\budget-quota-policy-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Budget Quota Policy Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
