# Inline Budget Authoring — Architecture Evidence

This exp-proof carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema and constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  plan-preview boundary.

## Parse, don't validate

This package applies the **parse, don't validate** discipline: untrusted Camp
policy input is parsed once at the boundary into derived domain types via
`normalizeCampPolicy`, and downstream `surfacePlanBudget` consumers receive those
parsed, derived types instead of re-checking raw DTOs. CUE constraints bound
the same derived types so malformed declarations fail at parse time.

## Event architecture

Plan-time surfacing is read-only. Runtime enforcement reuses ADR-0039 policy-plane
flow owned by the budget-quota-policy contract:

- **Command** — `EvaluateBudgetQuotaPolicy` (spend-incurring deploy or agent action).
- **Event** — `policy.Decided`, `spend.DegradationRequired` appended to the log.
- **Actor** — policy gate actor applies quota reservations and degradation obligations.
- **Event store** — accepted policy and spend events append to the platform event store.
- **Materialized view / projection** — `MeteringView` folds meter/spend facts for velocity checks.
- **Snapshot** — seq-pinned metering snapshot is the snapshot input for plan/policy evaluation.
- **Read store** — `hobo plan` and FinX surfaces read plan/budget projections, not the raw log.

No runtime engine is implemented here; this proof names the boundaries so plan
surfacing stays aligned with the policy contract vocabulary.
