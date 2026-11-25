---
name: verify-budget-policy-routing
description: Verify credit and hard-budget dispatch selection and reservation accounting when changing the dispatcher, its contracts, or its callers.
---

# Budget-policy routing

**Properties:** With valid inputs and an authoritative quote, admission must not understate paid exposure or exceed the hard budget. Pending releases and bounded final settlements must not create funds, free credits, or slots. Running settlement requires final usage evidence, and provider overruns are explicitly marked.

**Why:** Wrong routing can either launch paid work without an adequate hold or refuse work the customer can afford.

## Static & Alchemy Domain invariant reduction

`@hobo/dispatcher/domain` (`DispatchRouting`, implemented with EffectTS schemas and `@alchemy.run/domain`) eliminates five previously modeled failure classes by construction, removing their redundant TLA+ models and Z3 proofs (`DispatchScope`, `DispatchOrdering`, `LedgerSequence`, `ReservationConsumption`, and `EstimateRouting`):

- **Category scope (`ScopedAccountId`):** Nominal category brands (`RunnerAccountId`, `BuildMachineAccountId`, `TrafficBackendAccountId`) and per-category-account `DispatchAccount` aggregate streams prevent cross-category holds at compile time.
- **Single-release & bounded holds (`ReservationEntry` + `ActiveReservationHold`):** Discriminated tagged-union reservation states (`Pending`, `Running`, `Confirmed`, `Released`, `Expired`) omit the `hold` field from terminal states, and `ActiveReservationHold` enforces `freeUnits + paidUnits === units` and `concurrencySlots <= units` at parse time.
- **Atomic sequencing (`DispatchAccount` aggregate):** `@alchemy.run/domain` owns atomic per-command stream versioning and single-event `ExpirePendingReservations`, eliminating partial-batch sequence exhaustion.
- **Locale-independent deterministic ordering (`selectDispatchCandidate`):** Exact integer micro-dollars (`NonNegativeMicros`), full all-in estimate admission, and UTF-16 code-unit tie-breaking (`compareCodeUnits`) with no `localeCompare` path.

## Covered code

- `packages/dispatcher/src/domain/`: `DispatchRouting` Alchemy Domain model (`ids.ts`, `selection.ts`, `DispatchAccount.aggregate.ts`, `model.ts`).
- `packages/dispatcher/test/dispatch-routing-domain.test.ts`: `Domain.verify(DispatchRouting)`, compile-time `@ts-expect-error` negative proofs, schema boundary checks, deterministic selection checks, and executable `Story.make` BDD scenarios.
- `packages/dispatcher/src/dispatcher.ts`, `src/dispatcher-v2.ts`, `src/money.ts`, `src/order.ts`: legacy wire-compatible dispatcher and decimal conversion layer.
- `packages/dispatcher/data-models/dispatch.cue` and `dispatch.proto`: wire numeric domain.
- `packages/dispatcher/test/budget-routing.property.test.ts`, `budget-safety.test.ts`, `money-overflow.test.ts`, `ledger-sequence-safety.test.ts`, `ledger-consumption-safety.test.ts`, `budget-category-scope.test.ts`, `budget-estimate-routing.test.ts`, `dispatcher-locale.test.ts`, `dispatcher-v1-byte-identical.test.ts`: legacy compatibility and overflow regression suites.

## Run

From the repository root after installing workspace dependencies:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-budget-policy-routing
```

The command runs the Alchemy Domain BDD + property suites, the core Z3 4.15.4 `budget_induction.py` exact-arithmetic proof, TLC 1.7.4 on `BudgetRouting.tla` (plus its three weakened-model mutation checks), and CUE wire fixtures. Set `BUDGET_Z3_PYTHONPATH` to an existing `z3-solver==4.15.4.0` installation and `TLA2TOOLS` to the pinned TLC 1.7.4 jar for offline runs.

## Scope and evidence

- **Alchemy Domain BDD + static types (`dispatch-routing-domain.test.ts`):** Verifies `Domain.verify(DispatchRouting) === []`, nominal category isolation, terminal reservation hold absence, branded integer micro-dollar and hold bounds, deterministic tie-breaking, hard budget caps, running-settlement evidence, single release, and atomic expiry.
- **TLC (`BudgetRouting.tla`):** Explores 1,246 distinct states with two requests, two attempts, one provider, a two-unit budget, and unit holds; proves `NoUnfundedAdmission`, `RunningSettlementNeedsEvidence`, and `BudgetSafeUntilProviderOverrun`, with three mutant models confirming counterexamples when those guards are removed.
- **Z3 (`budget_induction.py`):** Proves by induction over exact reals that reserve, pending-release, and bounded settlement preserve `spent + held <= cap`, that a positive quote cannot fit a zero cap, and that provider overrun outside the hold can exceed the cap.

Scratch mutations for overflow and estimate regressions remain runnable via:

```sh
python3 .agents/skills/verify-budget-policy-routing/mutations/full.py
```

## Keep in sync

When dispatcher routing rules change, prefer tightening Effect schemas, nominal brands, and `DispatchRouting` aggregate invariants first, then update `dispatch-routing-domain.test.ts`, `BudgetRouting.tla`, and `budget_induction.py` only for invariants that static types cannot express. Keep `.agents/skills/verify-budget-policy-routing/` and `.claude/skills/verify-budget-policy-routing/` byte-identical.
