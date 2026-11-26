# Repo/View Escape Hatches Contract POC

Independent POC for HOBO-96, defining the snapshot, `repo`, `view`, and predicate
escape-hatch contract over a cached projection/sink read model.

## Contract

- `snapshot(store)` returns the current cached projection value and per-stream `seq`.
- `repo(store, name).get(id, ctx)` performs a backend-neutral point read by logical projection name.
- `repo(store, name).find(predicate, ctx)` composes the user predicate with the platform tenant filter.
- `view(store, name, ctx).where(predicate).asLiveView()` exposes live-view intent without implementing
  Reactor delivery.
- `useQuery(store, name, ctx)` is the reactive query sugar for the same logical projection contract.
- `eq`, `in`, `range`, and `and` are the shared predicate DSL shape used by domain queries, search filters, and
  tenant scoping.
- `runDoctor(store)` surfaces cost/reactivity risks without silently changing the read result.

## Proof

- Cached snapshots carry the projection `seq` and report a cache hit.
- Identical app code reads the same row through native and Postgres projection sinks.
- Domain predicates compose with the platform-owned tenant filter across `eq`, `in`, and `range`.
- Reads resolve logical projection names and reject table-shaped names.
- Tenant-scoped reads with no resolved tenant fail closed.
- Non-indexed predicates are allowed but flagged as `NON_INDEXED_PREDICATE`.
- Cross-tenant predicates cannot override the platform tenant filter.
- Non-reactive sinks still support point reads but warn when asked to act as a live view.

## Scope Boundary

This package proves the escape-hatch read contract only. It does not implement Reactor re-push
mechanics, `.raw(driver => ...)`, cursor pagination, full-text search execution, provider sink
adapters, or cross-tenant admin policy.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\repo-view-escape-hatches-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Repo View Escape Hatches Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
