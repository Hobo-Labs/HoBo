# Cross-Camp Bounded-Staleness Projection Contract

Independent POC for HOBO-261. It proves the CAP-honest cross-Camp read path from Plan 32, ADR-0040, and ADR-0052:

- A projection declares a `single-writer-camp` replication topology with one owner Camp and non-owner replica Camps.
- A non-owner Camp folds the owner Camp's replicated read-stream with the same native projection fold as the owner.
- Replica reads and replicated-stream subscription pushes carry an explicit `bounded-staleness` label.
- Consistency-requiring writes attempted in a non-owner Camp route home to the owner and are not applied locally.
- Reads or replication reports whose lag exceeds the declared bound emit `projection.Lagged` as a policy input.

## Scope Boundary

This package does not implement replication transport, CRDT/active-active merge, ownership failover, strong cross-Camp consistency, provider-backed CDC, policy evaluation, or HOBO-278 projection-lag adversarial hardening. It emits the `projection.Lagged` signal that later hardening can stress.

## Executable Checks

```powershell
npm.cmd --prefix src\draft\technical-proofs\cross-camp-bounded-staleness-contract test
```

The tests cover same-fold replica materialization, staleness-labeled subscriptions, route-home writes, stale-read labeling, and lag-spike `projection.Lagged` emission without widening the declared bound.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Cross Camp Bounded Staleness Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
