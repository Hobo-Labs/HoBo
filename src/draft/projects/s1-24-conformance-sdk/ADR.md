# ADR: S1-24 SDK conformance gate draft POC

## Context

HOBO-614 promotes the composed SDK idiom-layer parity gate. Blockers S1-10/S1-11/S1-13
are Done on `main`; this draft POC proves the gate shape ahead of production promotion to
`packages/conformance/src/sdk/` and parity wiring in `@hobo/bindles` / `@hobo/runtime`.

## Decision

1. **Two required behavior lanes** reported separately per ADR-0093: golden-IR lowering
   equivalence and semantics annex.
2. **Resilience-semantics excluded** from v1 gate (HOBO-517); lane ids remain open strings in
   proto for forward compatibility.
3. **Failures carry canonical JSON diffs** at vector level, never bare booleans (HOBO-5 harness).
4. **Parse boundaries** at `parseSemanticsAnnexVectors` / `parseSdkConformanceReport` only.

## Consequences

- Promotion swaps `src/draft/projects/s1-24-conformance-sdk/` → `packages/conformance/src/sdk/`.
- Parity tests in `@hobo/bindles` and `@hobo/runtime` wire after their production surfaces merge.
