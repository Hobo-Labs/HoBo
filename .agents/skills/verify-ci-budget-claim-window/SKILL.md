---
name: verify-ci-budget-claim-window
description: Verify CI shared-budget claim timing at fixed-window boundaries.
---

# CI shared-budget claim window

**Property:** A CI claim may authorize execution only if the entire approved work duration still fits the funded window when the durable parent claim returns. If the claim already committed and the work no longer fits, the financial hold remains for reconciliation.

**Why:** A store lock can consume the remaining window after a valid pre-claim decision, leaving insufficient funded time even though the window itself has not expired.

**Result at sync commit `152160590bc0837c42744a4ccc81c4cfa95197d7`:** PASS for the stated generated and database-backed checks, bounded model, and arithmetic obligation.

## Covered code

- `packages/ci/src/shared-budget.ts` (`createCiSharedBudgetHooks` and `createCiAsyncSharedBudgetHooks`).
- `packages/ci/test/shared-budget.test.ts`.
- The shared evaluator is checked separately by `verify-shared-budget-policy`; parent ledger invariants are checked by `verify-broker-budget-authority`.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-ci-budget-claim-window
```

The command runs the CI shared-budget tests, TLC 1.7.4, and Z3 4.15.4. To exercise the PostgreSQL cases, set `HOBO_TEST_POSTGRES_URL` to an isolated test database. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to pinned installations for offline runs. Java 11+, Python, Node, Vitest, fast-check, and workspace dependencies are required. Use `/statechart` with `models/view.mts` to regenerate the projection.

## Scope and evidence

Generated checks use seed 614454 and 40 slack/delay examples for each synchronous and asynchronous interface, including exact-fit and one-millisecond-overrun boundaries. They exercise SQLite directly and through an async adapter. A separate test passed against a PostgreSQL 17 container, with the parent claim committed before the clock advances. Both interfaces also reject a claim when trusted allocation coverage is revoked during the claim; removing that recheck makes those tests fail. The time model does not model coverage revocation. The post-claim denial preserves the execution claim and reserved money; it is not an automatic unused release.

TLC explores 16 states of a bounded window, a claim that can wait, the committed hold, and allow/refuse outcomes. It checks the full duration at return and retains the hold after commit. Replacing the return-time duration check with a mere not-yet-expired test violates `AllowedWithinWindow`. Mutating the implementation to use the pre-claim time makes the generated checks fail. Z3 proves the stated return-time arithmetic obligation over unbounded nonnegative integer times and durations; `CI_CLAIM_WINDOW_MUTATION=omit-return-check` yields a counterexample.

The model assumes an accurate clock, an atomic and durable parent claim, trustworthy measurements, and a validated quote/native-bound verifier. It does not prove TypeScript refinement, live-provider billing behavior, liveness of reconciliation, or that execution starts immediately after the claim returns. Later delays require their own current authorization at the execution boundary.

## Keep in sync

Review covered changes, update both interfaces' implementation checks and model, replay counterexamples against the real code, run both database adapters and deliberate scratch mutations, regenerate the chart, and advance the sync commit after confirming correspondence. Use `/maintain-formal-verification-skill`.
