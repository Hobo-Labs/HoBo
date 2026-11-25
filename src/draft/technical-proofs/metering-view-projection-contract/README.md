# MeteringView Projection Contract POC

Independent POC for HOBO-243. It pins the M1 `MeteringView` projection skeleton from PLAN-05 and ADR-0039 without implementing showback presentation, quota gates, the CreditLedgerView fold, or billing reconciliation.

## Contract Surface

- `snapshotMeteringView(events, { seq, costCatalog })` rebuilds usage/cost counters from log facts up to a pinned `seq`.
- `applyMeteringEvent(snapshot, event, { costCatalog })` proves the incremental live fold reaches the same digest as a from-zero replay.
- `emitMeterRollups(snapshot)` emits deterministic `meter.RollupEmitted` summaries from the pinned snapshot.
- Counters are grouped by metering dimension and day bucket, with hierarchy keys for `tenant -> Camp -> Bindle -> run/agent/team`.

## Fixture Events

This POC intentionally keeps event shapes local and consumes `meter.UsageRecorded` fixture facts. The canonical `meter.*`/`spend.*` cost-signal schemas remain owned by HOBO-236.

## Scope Boundaries

Included:

- Deterministic rebuild-from-zero and incremental fold equivalence.
- `seq`-pinned snapshots and stable content digests.
- Cost calculation from `cost.json` unit prices.
- Owner hierarchy attribution and attribution-gap evidence.
- Idempotency-key deduplication and period-boundary bucketing.

Excluded:

- Showback UI/reporting.
- Quota, spend-breaker, and policy gate decisions.
- CreditLedgerView free-tier/credit folding.
- Estimate-vs-actual billing reconciliation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\metering-view-projection-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Metering View Projection Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
