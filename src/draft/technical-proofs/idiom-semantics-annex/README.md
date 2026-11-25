# Idiom Semantics Annex POC

Independent POC for HOBO-31. It pins the SDK idiom-layer semantics annex as a separate
conformance lane from golden-IR lowering equivalence.

## Requirements Source

- `docs/design/wasm-runtime-wit.md`: `hobo:sdk` plus idiom layers, parity is proven.
- `docs/design/adr/01-architecture-core.md#adr-0072`: WIT-first SDK and bounded idiom semantics.
- `docs/design/adr/01-architecture-core.md#adr-0093`: semantics annex lane decision.

## What This Proves

- A TypeScript idiom adapter can produce byte-identical `hobo:sdk` WIT calls and
  `hobo.manifest/v1` output while still mishandling language control flow.
- A bad adapter that swallows a WIT `result.err` passes golden-IR equivalence but fails the
  semantics-annex `error-mapping` vector.
- Cancellation must lower to a caller-owned `cancelled` WIT result, not a hidden retry.
- Async collection vectors sort by declared sequence and reject handlers observed before resource
  declarations.

## Scope Boundary

This does not build the real `@hobo/conformance/sdk` package, full multi-language suites, or non-TS
SDKs. It is the branch-sized executable annex contract for one TS primitive path.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\idiom-semantics-annex test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Idiom Semantics Annex.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
