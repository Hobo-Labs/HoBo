# Full-Text Search Contract POC

Independent POC for HOBO-245, proving the in-core full-text side of the generic `hobo:search` port.

## What This Proves

- A fixture corpus indexes into a deterministic full-text materialization and returns ranked hits.
- `data.Changed` from an indexed write re-pushes subscribed full-text results through the same reactive path.
- Search filters use the same predicate vocabulary as domain reads and tenant scoping.
- One search Bindle resolves to Postgres FTS for preview Camps and a managed search engine for prod.
- Query declarations fail closed when they reference non-indexed filter fields, ask for prefix search without a prefix-enabled index, or lack a resolved tenant.

## Scope Boundary

This is a contract POC only. It does not implement provider adapters, Postgres FTS, managed search services, vector/graph/OWL extensions, hybrid/RRF, embedding, or the migration machinery for index backfills. Those are separate slices.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\full-text-search-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Full Text Search Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
