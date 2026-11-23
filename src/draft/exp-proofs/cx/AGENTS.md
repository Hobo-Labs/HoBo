# Customer experience proof instructions

Follow the parent [experience proof instructions](../AGENTS.md). Implement the customer or publisher journey and verify it with executable tests or feature steps. Do not replace the behavior with journey plans or synthetic evidence. Remove obsolete proof artifacts after updating dependents.

Run `pnpm exec turbo run test --filter ./src/draft/exp-proofs/cx/<slug>` and the relevant staged artifact and cascade checks.
