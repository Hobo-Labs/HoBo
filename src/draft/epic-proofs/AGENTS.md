# Epic proof instructions

Follow `src/draft/AGENTS.md` and the repository-wide rules. Implement the requested integrated behavior using its owning packages, and keep `proof.json` references aligned with actual imports. Update and test affected lower-level packages when contracts change, and remove obsolete proofs and references after preserving meaningful executable feature checks in the owning packages.

Run `pnpm --prefix src/draft/epic-proofs/<slug> test` and the relevant staged checks. Epic features must have executable step definitions; run `pnpm run test:behavior` when relevant. The artifact gate also checks runnable examples and the required executed notebook.

Do not create ADRs, planning documents, or placeholder features.
