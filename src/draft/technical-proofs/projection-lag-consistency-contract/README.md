# Projection Lag Consistency Contract

Independent POC for HOBO-278. It proves the adversarial lag-honesty boundary from Plan 32, ADR-0040, and ADR-0052:

- Sustained write load beyond a declared projection staleness bound emits `projection.Lagged` without widening the bound.
- Change-feed sink reads are labeled `bounded-staleness` and never claim to be fresh or read-your-writes.
- Native log-backed session reads preserve reads-your-writes inside the owning Camp while lagging sink-cache reads stay honestly stale.
- `hobo doctor` reports the read class for native-log, bounded-staleness sink-cache, and eventual sink-cache reads.
- Transient lag bursts fire and then clear `projection.Lagged`.
- A sink that falls behind without emitting `projection.Lagged` fails the audit.
- Strong cross-Camp declarations that cannot be proven are flagged instead of silently downgraded.

## Scope Boundary

This package does not define the `projection.Lagged` event schema, implement replication transport, build a Reactor core, add provider-backed CDC, or execute SLO/alert policy actions. It is a branch-local harness for stressing the already-defined projection lag and consistency contract.

## Executable Checks

```powershell
npm.cmd --prefix src\draft\technical-proofs\projection-lag-consistency-contract test
```

The tests cover all acceptance bullets and adversarial cases from HOBO-278.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Projection Lag Consistency Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
