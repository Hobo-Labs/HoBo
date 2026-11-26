# Native Log Projection Contract POC

Independent POC for HOBO-74, defining the default native standing projection over the event log:

- `projection(name, { key, on })` lowers event-type handlers into a deterministic read-model fold.
- Read-model WIT row metadata rides both `projection.Declared` and materialized snapshots.
- The native sink is reactive by construction because the event log is the change stream.
- Index hints are declared with the projection contract, not bound to a provider sink.
- Write-capable folds are rejected before declaration.

## What This Proves

- A fixture event stream materializes a read model to the current per-stream `seq`.
- Same-key events fold deterministically in stream sequence order.
- Events outside the read-set never land in the projection.
- Malformed event bodies surface as poisonable `ProjectionFoldError` failures instead of silent drops.
- Native projections need no Postgres/Mongo/provider sink adapter to remain reactive.

## Scope Boundary

This package intentionally stops at the native log-backed projection contract. It does not implement
provider sink adapters, the Reactor push loop, schema mapping, or rebuild-from-zero scale machinery.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\native-log-projection-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Native Log Projection Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
