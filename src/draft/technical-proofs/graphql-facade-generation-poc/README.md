# GraphQL Facade Generation POC

Spike for HOBO-65.

## Finding

The GraphQL facade should be generated from two contract inputs:

- canonical WIT read-model records, which produce GraphQL object and enum types
- projection/materialization metadata, which produces query fields and, only for reactive materializations, subscription fields

Resolvers should be generated as thin dispatchers to the existing materialization read/subscription engine. They should not own a separate storage path, query planner, or reactivity engine.

## Generable

- GraphQL SDL for WIT records and enums
- query fields for materialization snapshot reads
- subscription fields for native or change-feed-backed reactive materializations
- stable field names from WIT kebab-case to GraphQL camelCase
- collision detection for query and subscription field names

## Hand-authored Or Policy-bound

- tenant and authorization policy hooks at the projection boundary
- custom pagination rules and indexed-sort constraints
- search, vector, OLAP, and raw escape-hatch behavior
- domain-specific resolver composition that is not a direct materialization read

## Recommendation

Adopt a deterministic `hobo codegen --graphql-facade` step that emits SDL and thin resolver/subscription stubs from `projection.Declared` plus canonical WIT records. Reject subscription generation for `reactive: false` materializations so non-reactive sinks cannot masquerade as live GraphQL streams.

## Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\graphql-facade-generation-poc test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Graphql Facade Generation Poc.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
