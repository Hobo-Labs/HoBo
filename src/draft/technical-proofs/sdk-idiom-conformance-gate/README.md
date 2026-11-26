# SDK Idiom Conformance Gate POC

Independent POC for HOBO-32: a branch-sized `@hobo/conformance/sdk` gate for the TypeScript
`@hobo/bindles` idiom layer over the canonical `hobo:sdk` WIT contract.

## Requirements Source

- `docs/design/wasm-runtime-wit.md#plan-20`: SDK parity is proven, not trusted.
- `docs/design/adr/01-architecture-core.md#adr-0072`: generated bindings plus a thin idiom layer.
- `docs/design/adr/01-architecture-core.md#adr-0093`: semantics-annex parity is separate from
  golden-IR lowering equality.
- `src/draft/technical-proofs/hobo-sdk-aggregate-wit-contract`: the `hobo:sdk@0.1.0` aggregate contract from HOBO-16.
- `src/draft/technical-proofs/idiom-layer-lowering-contract`: the HOBO-106 lowering corpus.
- `src/draft/technical-proofs/idiom-semantics-annex`: the HOBO-31 negative semantics vectors.

## What This Proves

- The gate has two required behavior lanes: golden-IR lowering equivalence and the semantics annex.
- The passing TypeScript idiom-layer fixture lowers to identical `hobo:sdk` calls and manifest IR,
  then passes error mapping, cancellation, async ordering, and IfC side-effect vectors.
- The gate now has a third required behavior lane: the resilience semantics annex from HOBO-516.
  Retry, denial, terminal failure, cancellation, deadline, cleanup, and replay-inspection helper
  claims fail unless matching resilience vectors are present and passing.
- A deliberately divergent fixture fails the golden-IR lane.
- A layer that lowers correctly but swallows WIT errors fails the semantics-annex lane.
- A layer/report that lowers correctly but hides cancellation as retry fails the resilience lane.
- Hand-authored and generated idiom layers use the same gate; there is no trusted-by-convention path.
- The report separates golden-IR, existing semantics-annex, resilience-semantics, thin-layer,
  authorship, and coverage failures so golden-IR success cannot mask a resilience failure.
- The report states the corpus boundary explicitly: off-corpus helper claims require golden-IR,
  semantics-annex, or resilience vectors before parity can be claimed. Unsupported helper behavior
  fails the coverage lane.

## Scope Boundary

This does not author non-TS idiom layers, build the full `@hobo/bindles` fluent surface, or implement
the AI-generation loop. It composes the existing HOBO-16, HOBO-31, HOBO-106, and HOBO-516 proof
packages into the SDK conformance gate that those future implementations must pass.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\sdk-idiom-conformance-gate test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Sdk Idiom Conformance Gate.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
