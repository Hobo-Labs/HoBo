# HOBO-581 maintenance (S0-04 draft POC)

Draft POC at `src/draft/technical-proofs/s0-04-protobuf-cue-codegen/` implements protobuf+CUE codegen with drift gate pending S0-01/S0-03 merge to `packages/`.

Gates: TypeScript (`packages/schema-tools/src`), protobuf/CUE (`data-models/`), PACT (`contracts/pacts/`), Vitest (`packages/schema-tools/test`), `pnpm run codegen:check`, `pnpm run generated:guard`.
