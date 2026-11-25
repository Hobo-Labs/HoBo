# HOBO-64 Matching Engine Skeleton Contract

This draft package proves the M1 matching engine seam for
ResourceDefinition selection:

1. gather definitions of the requested resource type from a catalog snapshot;
2. filter by exact context criteria;
3. score with the HOBO-55 specificity vector;
4. pick deterministically; and
5. emit a valid `match.Decided` control-plane event.

The package consumes the existing draft contracts for ResourceDefinition catalogs,
HOBO-55 specificity vectors, and control-plane event validation. Objective ranking,
hard capability requirements, PlanRejected behavior, and mapping-as-sugar compilation
remain outside this skeleton.

## Run

```powershell
npm.cmd --prefix src\draft\technical-proofs\matching-engine-skeleton-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Matching Engine Skeleton Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
