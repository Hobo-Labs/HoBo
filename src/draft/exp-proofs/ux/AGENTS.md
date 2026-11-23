# User experience proof instructions

Follow the parent [experience proof instructions](../AGENTS.md). Implement and verify the real user interface; retain actual visual evidence when it substantiates the behavior. Do not create design documents or placeholder mockups. Remove obsolete proof artifacts after updating dependents.

For playable or multi-step interactive interfaces, capture the running behavior with Playwright screenshots and MP4 recordings. Record each file's path, size, and SHA-256 in the evidence manifest, and inspect the captures before claiming completion.

Run `pnpm exec turbo run test --filter ./src/draft/exp-proofs/ux/<slug>` and the relevant staged artifact and cascade checks.
