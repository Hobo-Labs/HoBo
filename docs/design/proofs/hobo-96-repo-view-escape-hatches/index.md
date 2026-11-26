# HOBO-96 Repo/View Escape Hatches Proof

This proof backs [PLAN-32](../../data-plane.md#plan-32) and
[ADR-0050](../../adr/03-data-plane.md#adr-0050).

The executable POC in
[`src/draft/technical-proofs/repo-view-escape-hatches-contract`](../../../../src/draft/technical-proofs/repo-view-escape-hatches-contract)
proves the snapshot / `repo` / `view` escape-hatch contract:

- `snapshot` serves cached projection state with a per-stream `seq`;
- backend-neutral app code reads the same logical projection over native and Postgres sinks;
- the shared `eq` / `in` / `range` predicate DSL composes domain filters with the platform tenant filter;
- `useQuery` sugar resolves the same logical projection name and rejects table-shaped names;
- missing tenant context fails closed rather than returning all tenants;
- non-indexed predicates are permitted but produce a `hobo doctor` cost-risk warning;
- cross-tenant predicates cannot bypass the platform-owned tenant filter;
- non-reactive sinks keep point reads available while warning on live-view intent.

Scope kept out: Reactor re-push mechanics, `.raw(driver => ...)`, cursor pagination,
full-text search execution, provider adapters, and cross-tenant admin policy.
