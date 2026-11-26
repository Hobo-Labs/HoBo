# Non-TS Idiom Round Trip Spike

Independent spike for HOBO-398. It records the reverse path from an extracted Component Model
surface to a non-TypeScript idiom-layer skeleton, and the parity-report shape required before a
language SDK can claim equivalence with the `hobo:sdk` contract.

## Requirements Source

- `docs/design/adr/01-architecture-core.md#adr-0072`: WIT-first SDK, reverse extraction, and
  semantics-annex boundary.
- `docs/design/adr/01-architecture-core.md#adr-0091`: this spike decision.
- `docs/design/wasm-runtime-wit.md#the-sdk-is-provided-through-wit--hobosdk--idiom-layers-adr-0072`:
  forward and reverse WIT paths.
- `docs/design/authoring-resources-wiring.md#plan-21`: run-to-collect and manifest IR.
- `src/draft/technical-proofs/hobo-sdk-aggregate-wit-contract`: existing reverse-extraction POC.
- `src/draft/technical-proofs/idiom-layer-lowering-contract`: existing TypeScript lowering-equivalence POC.

## Worked Reverse Path

1. Start with an artifact surface extracted from a component. The sample is
   `fixtures/extracted-component-surface.json`.
2. Compare the extracted imports, exports, and signatures with the canonical `hobo:sdk@0.1.0`
   aggregate surface from HOBO-16.
3. If the surfaces match, emit a language adoption report. The sample report is
   `fixtures/parity-report.json`.
4. Generate a language-native skeleton as a starting point for the SWE operator or human SDK author.
   The sample Rust sketch is `fixtures/rust-skeleton.rs`.
5. The skeleton must map every ergonomic operation back to generated `hobo:sdk` calls and
   `hobo.manifest/v1` records. It is not allowed to copy TypeScript syntax as the contract.

## TypeScript-Specific Assumptions

| Assumption in `@hobo/bindles` | Non-TS risk | Mitigation |
|---|---|---|
| Fluent builder chains | Rust/Python/Go should not be forced into JS chaining syntax. | Treat builders as idiom-only. Require a lowering map from each operation to WIT call records. |
| IfC module-execution side effects | JS import order is not a portable collection model. | Define an ordered collection transaction of declaration facts. Rust can use macros/build scripts, Python decorators, or explicit registrars. |
| Decorators and dynamic proxies | Decorators are not universal, and proxies are JS-specific. | Keep decorators optional. Dynamic proxy behavior cannot be contract surface. |
| TS `throw` and promise cancellation | WIT `result<>` and cancellation semantics differ by language. | Put error/cancellation mappings in the semantics annex, not in golden-IR equivalence. |
| Structural object typing | Rust/Go nominal types may need explicit generated structs. | Parity is based on lowered WIT calls and manifest records, not source syntax. |

## Parity Report Shape

The report has four required lanes:

- `surface`: extracted WIT digest, import/export list, and signature drift status.
- `lowering`: golden-IR corpus status for WIT calls and `hobo.manifest/v1` output.
- `semanticsAnnex`: error, cancellation, async ordering, and IfC side-effect ordering status.
- `idiomTranslations`: TS-only assumptions and the target-language mitigation.

All lanes must be green, or explicitly waived with an issue reference, before a language idiom layer
claims parity. A green lowering lane alone is not enough.

## Recommendation

Do not refactor `@hobo/bindles` solely because it uses TypeScript-fluent ergonomics. Refactor only if
a TS feature cannot be represented as ordered collection facts, WIT call records, or manifest IR.
Before M2 implementation lands, freeze the lowering seam:

- public idiom-layer exports remain language-specific;
- declaration facts, WIT calls, and manifest records are contract-shaped;
- `.allow()`, `.with(...)`, `bind`, handler attach, and runtime primitive declarations each name a
  lowering record;
- semantics-annex gaps block parity rather than silently passing the golden-IR corpus.

## Scope Boundary

This spike does not build a Rust/Python/Go SDK, implement reverse extraction beyond the existing
HOBO-16 POC, or extend `@hobo/conformance/sdk`. It records the decision and the reviewable proof
shape for later SDK work.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Non Ts Idiom Roundtrip Spike.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
