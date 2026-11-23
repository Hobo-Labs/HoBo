# Developer experience proof instructions

Follow the parent [experience proof instructions](../AGENTS.md). Implement and test the actual developer or operator workflow; keep its protobuf and CUE contracts aligned. Do not create pseudo-code, diagrams, ADRs, or planning documents. Remove obsolete proof artifacts after updating dependents.

Run `pnpm exec turbo run test --filter ./src/draft/exp-proofs/dx/<slug>` and the relevant staged artifact and cascade checks.
