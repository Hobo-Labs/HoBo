# Draft package instructions

Follow the repository rules in `AGENTS.md`. Implement the requested behavior in its owning package and update affected contracts, consumers, and executable tests. Do not create planning documents, ADRs, placeholder proofs, or synthetic evidence.

Run package-scoped tests first. For a draft package, use `pnpm exec turbo run test --filter ./src/draft/<kind>/<package>`; experience proofs use `./src/draft/exp-proofs/<type>/<package>`. Run the relevant staged artifact and cascade checks as well.

The layer guides are [technical proofs](technical-proofs/AGENTS.md), [epic proofs](epic-proofs/AGENTS.md), [experience proofs](exp-proofs/AGENTS.md), and [projects](projects/AGENTS.md).
