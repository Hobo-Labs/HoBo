# POC rollup ledger — Gated Live-Fix Loop (HOBO-654)

| POC | Path | Issue | Persona | Scenario | Boundary | Dependencies | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| Live-fix gated candidate | `src/draft/technical-proofs/live-fix-gated-candidate-contract` | HOBO-368 | SRE | Failing trace → gated candidate | Live-fix applier | Sandbox, policy | verified | Composed directly; latest technical-proof change reconciled without changing the simulation. |
| SLO-gated rollback analysis | `src/draft/technical-proofs/slo-gated-rollback-analysis-contract` | HOBO-315 | SRE | Canary SLO burn → rollback | Delivery metric gate | SLO promotion gate | verified | Drives canary outcome |
| Generation pipeline live-fix | `src/draft/epic-proofs/generation-pipeline-training-ai-safety` | HOBO-307+ | Platform eng | Prod candidate approval | Generation reference | Human approval gate | verified | Scenario promoted |
| Progressive delivery harness | `src/draft/epic-proofs/progressive-delivery-harness` | HOBO-141+ | Platform operator | Canary promote/rollback | Harness boundaries | Mocked providers | verified | Canary pattern promoted |

## Requirement proven

The POC jointly proves FR-042 / Plan 23 live-fix gating:

1. Simulated SLO regression triggers the loop.
2. Low-risk staging fixes auto-canary with SLO-gated auto-rollback on failure.
3. Failing traces persist as permanent regression tests.
4. Production-classified fixes block until human approval.
5. Generation, validation, policy, and deployment steps land as replayable events.

## Cascade absorptions (83d9b5c92)

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/technical-proofs/slo-gated-rollback-analysis-contract` | final validated leaf hardening | Live-fix gating and rollback evidence unchanged. |
