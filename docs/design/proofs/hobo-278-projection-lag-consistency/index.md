# HOBO-278 Proof: Projection Lag Consistency

HOBO-278 hardens the CAP-honest projection read boundary: lagging change-feed sink reads must be bounded-staleness reads, `projection.Lagged` must fire when bounds are exceeded, and strong cross-Camp declarations that cannot be met must be flagged.

Proof package: [`src/draft/technical-proofs/projection-lag-consistency-contract`](../../../../src/draft/technical-proofs/projection-lag-consistency-contract)

## Requirement Coverage

- Sustained write load beyond the declared bound emits `projection.Lagged`.
- Change-feed sink reads carry a bounded-staleness label and never claim freshness.
- Session reads from the native log see owner-Camp writes while eventual sink reads are honestly stale.
- `hobo doctor` reports each read's class.
- Transient lag over the bound fires and clears `projection.Lagged`.
- A sink silently falling behind without `projection.Lagged` fails the lag audit.
- Strong cross-Camp consistency claims that cannot be proven are flagged instead of downgraded.

## Verification

```powershell
npm.cmd --prefix src/draft/technical-proofs/projection-lag-consistency-contract test
npm.cmd test
npm.cmd run docs:design-lint
node scripts/validate-traceability.ts
```

Scope intentionally excludes the event schema definition, replication transport, Reactor core work, and SLO/alert policy actions; this proof only exercises the projection lag and read-class contract.
