# Data Paradigm Authoring Contract

Executable POC for HOBO-389. It proves that SDK authors can opt a `data(name)`
handle into imported paradigm package descriptors without changing the portable
`hobo:data` resource boundary.

## Scope

- `data(name)` remains the portable default and emits no paradigm field or
  specialization marker.
- `data(name).use(importedPackage)` records a surfaced specialization marker
  while keeping the manifest resource on `hobo:data`.
- `@hobo/vector` and `@hobo/graph` also surface their `hobo:search` extension
  port as extension metadata on the same `data` resource.
- The authoring boundary rejects mixing two paradigm packages on one data
  resource.
- `.with()` native pins, Resource Definition references, and `.raw()` dialect
  reads stay reachable after opt-in and surface portability debt markers.
- Cross-paradigm-only package features become explicit `paradigm-mismatch`
  lock-in markers for later PortabilityReport consumption.
- Imported package descriptors do not redeclare `@hobo/sql`, `@hobo/vector`,
  `@hobo/graph`, or `@hobo/document` authoring symbols.

## Out of Scope

This package does not implement the actual Data Plane paradigm packages,
Matching, provider-native selection, migration, repository/query primitives, or
PortabilityReport computation.

## Verification

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\data-paradigm-authoring-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Data Paradigm Authoring Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.

## Testing

Run `pnpm --filter @hobo/draft-data-paradigm-authoring-contract test` (Vitest,
followed by a `tsc --noEmit` type-test). The implementation exports `DataHandle`,
`ImportedParadigmPackage`, `LoweringDescriptor`, and `ProviderOption`, which
`test/type-consumer.ts` pins; the concrete handle is `DataHandleImpl`.
