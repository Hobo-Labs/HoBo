# ax experience proofs

Agent experience (MCP is the agent surface). Artifacts: MCP transcripts, tool schemas, llms.txt fixtures (`assets/` or `transcripts/`). Keep parity with the CLI surface explicit.

Everything else (proof.json, executed examples/, notebook, cascade rule, run commands) follows the
parent [`src/draft/exp-proofs/AGENTS.md`](../AGENTS.md). Run a package with
`pnpm exec turbo run test --filter ./src/draft/exp-proofs/ax/<slug>`; validate artifacts with
`pnpm run draft:artifacts -- --staged`. Changing a proof here cascades into referencing epic
rollups — update them in the same diff (`pnpm run draft:cascade -- --staged`).
