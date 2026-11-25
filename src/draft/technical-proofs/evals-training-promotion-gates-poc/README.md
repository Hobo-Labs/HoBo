# Evals + Training Promotion Gates POC (HOBO-653)

Independent draft POC for S5-08: `@hobo/evals` rubrics + promotion gates and
`@hobo/training` capture/lint without waiting on production `packages/` layout.

## Scope

- **evals/** — rubric registry + three-pass promotion gate (conformance, eval, policy)
- **training/** — training-engine port shim, built-in OPTO optimizer, OpenInference capture
- **lint/** — flags `"use training"` methods missing intent, contract, or rubric
- **otlp/** — exports OpenInference spans + live-eval rewards to a tenant OTLP backend

Reuses existing draft contract modules from sibling technical proofs.

## Run

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/evals-training-promotion-gates-poc
```

## Acceptance (BDD)

1. Fixture challenger promotes through conformance + eval + policy with provenance events
2. Rubric-failing challenger stays shadow
3. OpenInference spans and live-eval rewards export to tenant OTLP backend
4. Lint reports missing semantic grounding on invalid `"use training"` sources

## Architecture Evidence

- `architecture/` — protobuf + CUE + PACT for architecture guard
- `ADR.md` — parse-don't-validate notes
- `test/acceptance.test.ts` — architecture artifact boundary test pins proto/CUE/Pact/ADR
