# Idiom Layer Lowering Contract POC

Independent POC for HOBO-106: fluent Layer 3/4 `@hobo/bindles` inputs lower to the same
canonical `hobo:sdk` calls and `hobo.manifest/v1` IR that a mechanical WIT binding path would
produce.

## Requirements Source

- `docs/design/sdk-api.md#plan-02`: WIT-first SDK, Layer 3 topology, Layer 4 runtime primitives.
- `docs/design/adr/01-architecture-core.md#adr-0069`: thin SDK, no cloud logic.
- `docs/design/adr/01-architecture-core.md#adr-0072`: generated bindings plus a thin idiom layer,
  lowering-equivalence corpus, semantics annex.

## What This Proves

- Golden fluent corpus lowers to ordered `hobo:sdk/*` call records and a byte-identical manifest.
- A thin-layer source scan rejects provider/cloud runtime imports and hidden provider defaults.
- A local adapter for the `@hobo/conformance/sdk/lowering-equivalence` report compares TS lowering
  against a canonical manifest path and records `fixtures/lowering-corpus.json` as the corpus source.
- `.with(...)` provider options lower as inert manifest annotations only; the POC asserts they do not
  resolve a provider or carry provider defaults.
- Semantics-annex guards cover typed WIT-result error mapping, cancellation, async ordering across
  awaited collection steps, IfC side-effect ordering, and hidden semantic defaults such as implicit
  retries.

## Scope Boundary

This does not build the real `@hobo/bindles`, `hobo:sdk` WIT package, `@hobo/conformance/sdk`, WIT
bindings, or Hobo Code DSL. It is the branch-sized contract POC for the lowering seam those packages
must preserve.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\idiom-layer-lowering-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Idiom Layer Lowering Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
