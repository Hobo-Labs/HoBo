# S1-24 @hobo/conformance/sdk draft POC (HOBO-614)

Draft traceability copy of the S1-24 SDK idiom-layer parity gate. **Production promotion
target:** `packages/conformance/src/sdk/` (`@hobo/conformance/sdk`). Blockers HOBO-599,
HOBO-600, and HOBO-602 are Done; parity tests in `@hobo/bindles` and `@hobo/runtime` wire
on promotion when `SdkIdiomAdapter` exports land on those packages.

## Scope

- Five lanes: `golden-ir-lowering-equivalence`, `semantics-annex`, `thin-idiom-layer`,
  `authorship-neutral-gate`, `coverage-claim` (no resilience-semantics — HOBO-517)
- `SdkIdiomAdapter` seam: `lower`, `mapResult`, `mapCancellation`, `collect`
- Vector-level diffs (`expected_json`, `actual_json`, `diff_paths`) on annex failures
- Parse-don't-validate constructors for vectors, corpus, and reports
- Protobuf + CUE data-models and PACT report-boundary contract
- Seeded drift proof: cancellation hidden as retry passes golden-IR, fails annex

## Out of scope

- Resilience-semantics annex lane (HOBO-517)
- Production wiring into `@hobo/bindles` / `@hobo/runtime` (SdkIdiomAdapter exports + parity tests)
- Runtime-port conformance harness (S1-10)

## Validation

```bash
pnpm --prefix src/draft/projects/s1-24-conformance-sdk build
pnpm --prefix src/draft/projects/s1-24-conformance-sdk test
pnpm run test:file src/draft/projects/s1-24-conformance-sdk/test/seeded-drift.test.ts
```

## Architecture evidence

- `data-models/sdk_conformance.proto` + `data-models/sdk_conformance.cue`
- `contracts/pacts/sdk_conformance_report.pact.json`
- `src/sdk/vectors/semantics-annex.vectors.json` — four HOBO-31 annex vectors
- `src/sdk/corpus/lowering-corpus.json` — golden-IR lowering fixtures

## Promotion path

Promote to `packages/conformance/src/sdk/` when moving off the draft POC path.

Reference drafts (read-only): `src/draft/technical-proofs/sdk-idiom-conformance-gate/`,
`src/draft/technical-proofs/idiom-semantics-annex/`.
