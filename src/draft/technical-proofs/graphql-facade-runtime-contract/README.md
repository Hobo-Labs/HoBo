# GraphQL Facade Runtime Contract

Independent POC for HOBO-92.

## What This Proves

- GraphQL query resolvers read materializations through cached snapshots.
- Repeated identical queries hit the snapshot cache and do not re-fold.
- GraphQL subscriptions attach to the same observable materialization as queries.
- Snapshot positions are carried as per-stream seq vectors, matching the Reactor contract.
- Tenant resolution fails closed before any read can return all tenants.
- `.allow()` field scopes are enforced at the resolver/projection boundary.
- Non-reactive sinks support one-shot query reads but reject subscription wiring.
- Stale snapshots beyond the materialization consistency bound are refreshed.
- Session/strong snapshots refresh when their materialization log position advances.
- Cross-tenant rows emitted by a buggy resolver/materialization are caught before return.

## Scope Boundary

This is a contract POC only. It does not implement SDL generation, cursor pagination, search/vector resolvers, sink adapters, Streamer transport, or the Reactor runtime.

## Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\graphql-facade-runtime-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Graphql Facade Runtime Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
