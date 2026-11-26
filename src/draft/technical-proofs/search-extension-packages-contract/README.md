# Search Extension Packages Contract

Independent POC for HOBO-252. It proves `@hobo/vector` and `@hobo/graph` as opt-in idiom layers over `hobo:search` extension capabilities.

## What This Proves

- Vector search returns cosine-ranked `{ id, score }` hits with typed filters and is always a `run.StepCompleted` step, not a reactive subscription.
- Hybrid search uses reciprocal rank fusion to compose full-text hits with vector-extension hits as a step.
- `hobo:embed` has a local no-egress path for air-gapped/dev Camps and hosted embedders surface egress/cost policy signals.
- Vector index changes use `migration.*`; embedding-model changes require a re-embed backfill.
- Graph traversal is an opt-in search extension and rejects portable predicate DSL traversal.
- New vector/graph event families are rejected; search extensions reuse existing `run.*` and `migration.*` families.

## Scope Boundary

This package does not implement full-text search, Matching, provider adapters, pgvector, Pinecone/OpenSearch/Azure AI Search, graph databases, OWL reasoning, runtime execution, or policy evaluation. It only pins the package-level contract and fail-closed behavior.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\search-extension-packages-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Search Extension Packages Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
