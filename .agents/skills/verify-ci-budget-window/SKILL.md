---
name: verify-ci-budget-window
description: Verify CI shared-budget reservation and claim timing at fixed-window boundaries.
---

# CI shared-budget window

**Property:** A committed reservation or execution claim may return successfully only if the full approved work duration still fits the funded window at return. If a post-commit recheck fails, the financial hold remains and the result is not a pre-commit denial that permits offer fallback.

**Why:** A store lock can consume the remaining window after a valid pre-commit decision, leaving insufficient funded time even though the window itself has not expired.

**Result at sync commit `fc83199b770987ffcaa10ad06a5b71a1f0f055ea`:** PASS for the stated generated and database-backed checks, bounded models, and arithmetic obligation.

## Covered code

- `packages/ci/src/shared-budget.ts` (`createCiSharedBudgetHooks` and `createCiAsyncSharedBudgetHooks`).
- `packages/ci/test/shared-budget.test.ts`.
- The shared evaluator is checked separately by `verify-shared-budget-policy`; parent ledger invariants are checked by `verify-broker-budget-authority`.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-ci-budget-window
```

The command runs the CI shared-budget tests, TLC 1.7.4, and Z3 4.15.4. To exercise PostgreSQL cases, set `HOBO_TEST_POSTGRES_URL` to an isolated test database. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to pinned installations for offline runs. Java 11+, Python, Node, Vitest, fast-check, and workspace dependencies are required. Use `/statechart` with `models/view.mts` or `models/reserve-view.mts` to regenerate the projections.

## Scope and evidence

Generated checks use seeds 614454 and 614455 and 40 slack/delay examples for each synchronous and asynchronous claim and reservation interface, including exact-fit and one-millisecond-overrun boundaries. They exercise SQLite directly and through an async adapter. Separate claim and reservation tests passed against a PostgreSQL 17 container, with the parent operation committed before the clock advances. The post-commit failure preserves the hold and is not reported as a pre-commit admission denial; a claimed hold retains its execution identity. Both interfaces also recheck quote validity, native liability evidence, and allocation coverage after a reservation, and recheck allocation coverage after a claim. Tests invalidate those inputs across the commit boundary; the time models do not model their verification.

`ClaimWindow` and `ReserveWindow` each explore 16 states of a bounded window, an operation that can wait, a committed hold, and allow/refuse outcomes. They check the full duration at return and hold retention; the reservation model also forbids fallback while the hold exists. Replacing the return-time duration guard with a mere not-yet-expired test violates the relevant window invariant. Permitting fallback with a committed hold violates `NoFallbackWithHold`. Mutating the implementation to use the pre-operation time makes the generated checks fail, and omitting post-claim coverage revalidation fails both coverage tests.

Z3 proves the stated return-time arithmetic obligation over unbounded nonnegative integer times and durations; `CI_BUDGET_WINDOW_MUTATION=omit-return-check` yields a counterexample. The models assume an accurate clock, atomic durable parent operations, trustworthy measurements, and validated quote/native-bound evidence. They do not prove TypeScript refinement, live-provider billing behavior, liveness of reconciliation, or that execution starts immediately after a claim returns. Later delays require current authorization at the execution boundary.

## Keep in sync

Review covered changes, update both interfaces' implementation checks and models, replay counterexamples against real code, run both database adapters and deliberate scratch mutations, regenerate the charts, and advance the sync commit after confirming correspondence. Use `/maintain-formal-verification-skill`.
