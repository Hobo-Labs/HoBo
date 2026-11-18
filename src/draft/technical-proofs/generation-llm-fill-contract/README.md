# Generation Contract Fill

`fillGenerationCandidate()` preserves an executable generation template and
adds content-addressed, contract-bound evidence. The result records the model,
seed, frozen prompt, authoritative inputs, material provenance, fill mode, and
claimed capabilities without allowing material to change the target WIT port or
capability contract.

Run `pnpm --prefix src/draft/technical-proofs/generation-llm-fill-contract test`.
