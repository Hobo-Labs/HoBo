# Saga Compensation and Credit Reconciliation Spike

Independent POC for HOBO-339. It records the spike result for saga compensation
correctness and CreditLedger estimate-vs-actual reconciliation before production
compensation, billing adapter, or spend-breaker work exists.

## Source Requirements

- [Plan 05: Reliability, observability, and cost](../../../../docs/design/reliability-observability-cost.md#plan-05)
- [Saga compensation algorithm](../../../../docs/design/reliability-observability-cost.md#saga-compensation-algorithm)
- [Cost signals](../../../../docs/design/reliability-observability-cost.md#cost-signals-costjson-in-capability-manifest)
- [Dispatcher cost routing](../../../../docs/design/reliability-observability-cost.md#the-dispatcher-creditbudget-aware-cost-routing)
- [ADR-0071](../../../../docs/design/adr/01-architecture-core.md#adr-0071)
- [ADR-0039](../../../../docs/design/adr/02-identity-security.md#adr-0039)

## Compensation Invariants

The prototype pins these constraints for later compensation-engine work:

- Rollback touches only resources that reached HoBo `Provisioned` state.
- Destroy order is reverse topological order over the deployment DAG.
- Every destroy command carries a deterministic idempotency key.
- Optional resource failure can remain partial success when required resources stay healthy.
- Compensation failure must report `needs-human`; it must not report rollback success.
- A provider object created before HoBo records state is ambiguous unless the provider object
  is discoverable by stable tags and an orphan sweep runs before terminal success.

## Failing Interleaving

The adversarial interleaving found by the executable proof:

1. Provider returns success for creating `database`.
2. Worker crashes before `state.recorded(database)` appends.
3. Rollback starts from HoBo state and cannot find `database`.
4. If the provider object lacks stable tags, no deterministic destroy target exists.

Constraint surfaced: provider adapters must stamp HoBo deployment/resource tags before or
atomically with provider create, and rollback cannot reach terminal success until an orphan
sweep proves no tagged provider object remains. If the orphan identity is unknown, the saga
must escalate to `needs-human`.

## Cost Accuracy Sample

The prototype used this sample:

| Provider | Meter | Estimate | Actual | Error |
| --- | ---: | ---: | ---: | ---: |
| aws | runtime-compute-seconds | 100 | 112 | 12% |
| aws | storage-gb | 40 | 38 | 5% |
| azure | egress-gb | 80 | 100 | 25% |

Measured bound: max absolute percent error is 25%, mean absolute percent error is 14%.
For this spike, `X = 10%`: any reconciled period outside 10% is categorized as
`pricing-or-usage-drift` and should lower the Dispatcher confidence for that
provider/meter until the catalog estimate is corrected.

## Deterministic Reconciliation

`reconcileBillingPeriod()` emits one `spend.ReconciliationDeltaRecorded` per
`(provider, period, meter)` with idempotency key:

```text
spend-delta:<provider>:<period>:<meter>
```

CreditLedgerView should fold estimated `spend.*` facts first, then fold these actual
delta events exactly once. Replay is safe because already-seen idempotency keys are
skipped, so a billing replay cannot double-count actual deltas.

Providers without an actual billing API are marked `estimate-only` with
`provider-billing-api-unavailable`. The prototype intentionally emits no actual delta
for those providers; Dispatcher must treat their effective marginal cost as uncertain.

## Recommendations

Compensation engine:

- Persist provider object identity and stable tags before reporting `Provisioned`.
- On rollback, destroy provisioned resources in reverse topological order.
- Run a tag-based orphan sweep for ambiguous create-before-state-recorded windows.
- Add a `needs-human` terminal for failed or unknowable compensation.

CreditLedgerView:

- Fold `spend.ReconciliationDeltaRecorded` by deterministic idempotency key.
- Store estimate, actual, delta, provider, period, meter, and ledger seq on each delta.
- Publish meter-level confidence from observed estimate error.

Dispatcher:

- Pin `CreditLedgerView@seq` into dispatch decisions as ADR-0071 requires.
- Lower cost confidence or choose safer routing when a provider/meter exceeds the error bound.
- Treat missing provider billing APIs as cost-uncertain; do not fabricate accuracy.

## Scope Boundaries

This POC does not implement the production compensation engine, provider billing API
adapter, spend breaker, degradation tiers, or Dispatcher routing logic.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\saga-credit-reconciliation-spike test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Saga Credit Reconciliation Spike.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
