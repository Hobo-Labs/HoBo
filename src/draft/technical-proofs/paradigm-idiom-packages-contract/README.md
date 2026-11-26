# Paradigm Idiom Packages Contract

Independent POC for HOBO-248. It proves the `@hobo/sql` and `@hobo/document` authoring packages as
thin idiom layers over `hobo:projection`, without implementing provider selection, sink adapters,
Matching/Dispatcher logic, `.raw`, `@hobo/vector`, or `@hobo/graph`.

## Requirements Source

- `docs/design/data-plane.md#plan-32`: opt-in paradigm packages lower to `hobo:projection`.
- `docs/design/adr/03-data-plane.md#adr-0081`: paradigm packages carry portability honesty and
  canonical WIT schema sharing without silent cross-paradigm swaps.
- `docs/design/adr/01-architecture-core.md#adr-0072`: SDK idiom layers stay thin and lower to the
  same WIT bindings and manifest IR.

## What This Proves

- `@hobo/sql` and `@hobo/document` lower to byte-identical `hobo:projection` WIT calls and
  `hobo.manifest/v1` resources as the generic `data` surface for the same target.
- Canonical WIT record schemas feed both packages through explicit `schema.wit` identity; package
  metadata is kept out of the manifest IR.
- Matching-default natives are represented as inert selection metadata, and `.with` or Resource
  Definition pins that leave the package's portability class are surfaced as `PortabilityReport`
  debt.
- The conformance suite round-trips ordered fixture events through the package/native-adapter pair
  and preserves the bounded-staleness consistency label.
- The thin-SDK scan rejects provider SDK imports and provider realization logic in the idiom package.
- A shared WIT record type is not enough to swap relational and document projections; an explicit
  remodel mapping is required.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\paradigm-idiom-packages-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Paradigm Idiom Packages Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
