# Cost Signal Contract POC

Independent POC for HOBO-236. It pins the M0 FinOps contract that downstream MeteringView,
CreditLedgerView, Dispatcher, quota, and showback work consume.

## Contract Surface

- `cost.json` is versioned as `hobo.cost/v1` and carries a provider id, ISO currency, regions,
  tier declarations, `unitPrices`, and `freeTier` reset windows.
- Cost-signal events are versioned as `hobo.cost-signal-event/v1` and cover:
  - `meter.UsageRecorded`
  - `spend.Recorded`
  - `spend.CircuitTripped`
  - `spend.CircuitReset`
  - `spend.DegradationRequired`
  - `spend.DegradationApplied`
  - `spend.DegradationRolledBack`
  - `credit.Registered`
  - `credit.Reset`
  - `credit.Exhausted`
  - `credit.BudgetCapSet`
- `CreditLedgerView` snapshots are versioned as `hobo.credit-ledger-view/v1`, include a replay-pinned
  `seq`, and serialize with a deterministic content digest.

## Guardrails

The POC proves the adversarial cases from the issue:

- Mixed provider currencies fail the catalog set check.
- A free-tier reset that crosses a metering period is split into deterministic spans.
- Negative unit prices and unapproved zero unit prices fail closed. Same-region egress is the only
  zero-rated exception because the design sample explicitly models it as `0`.
- A plan region missing from `cost.json` fails coverage.
- Tiered prices can only use declared tier keys.
- Region-keyed prices can only use declared provider regions.

## Scope Boundaries

Included:

- Canonical schema and validation for cost provider signals, cost events, and replay-pinned ledger
  snapshots.
- Deterministic serialization helpers suitable for fixture and contract tests.

Excluded:

- MeteringView or CreditLedgerView projection logic.
- Dispatcher ranking, reservation-CAS, or cost routing decisions.
- Billing, chargeback, or provider billing reconciliation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\cost-signal-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Cost Signal Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
