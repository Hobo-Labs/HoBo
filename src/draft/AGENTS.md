# Draft package instructions

Follow the repository rules in `AGENTS.md`. Implement the requested behavior in its owning package and update affected contracts, consumers, and executable tests. Remove obsolete proofs and their references once their behavior lives and is verified in its owning package; keep any proof that still contains the only implementation until then. Do not create planning documents, ADRs, duplicate or placeholder proofs, or synthetic evidence.

Run package-scoped tests first. For a draft package, use `pnpm exec turbo run test --filter ./src/draft/<kind>/<package>`; experience proofs use `./src/draft/exp-proofs/<type>/<package>`. Run the relevant staged artifact and cascade checks as well.

The layer guides are [technical proofs](technical-proofs/AGENTS.md), [epic proofs](epic-proofs/AGENTS.md), [experience proofs](exp-proofs/AGENTS.md), and [projects](projects/AGENTS.md).
