# Technical proof instructions

Follow `src/draft/AGENTS.md` and the repository-wide rules. Implement the requested technical behavior and verify it with deterministic tests and the applicable protobuf, CUE, and Pact contracts. Keep `proof.json` references aligned with actual dependencies.

Run `pnpm --prefix src/draft/technical-proofs/<slug> test`, then the relevant staged artifact and cascade checks. The artifact gate executes the examples and checks the notebook and applicable benchmark. Record a reason in `proof.json` only when a requirement does not apply; do not waive unfinished behavior.

Update and test affected referencing packages. Do not create ADRs, design documents, or placeholder proofs.
