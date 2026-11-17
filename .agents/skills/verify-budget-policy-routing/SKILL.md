---
name: verify-budget-policy-routing
description: Verify credit and hard-budget dispatch selection and reservation accounting when changing the dispatcher, its contracts, or its callers.
---

# Budget-policy routing

**Properties:** With valid inputs and an authoritative quote, admission must not understate paid exposure or exceed the hard budget. Pending releases and bounded final settlements must not create funds, free credits, or slots. Imported consumption is checked against reserved units and slot count. A combined dispatch reserves the selected category, considers the all-in estimate while selecting, and refuses recognizable inconsistent historical bindings. New dispatcher tie-breaks are locale-independent for identical ranked facts; legacy replay and quote generation have separate limitations. Ledger mutations cannot reuse an unsafe sequence, and sequence exhaustion cannot partially expire a batch.

**Why:** Wrong routing can either launch paid work without an adequate hold or refuse work the customer can afford.

**Review basis:** commit `3fd4f5882a97942fc0f200b03d8dab2200e529b9`. Before the corrections, the implementation failed on exact-cent affordability, a positive charge rounded to zero, sequence exhaustion, and excessive imported consumption. A same-provider registration in a different category could previously direct holds to the wrong account, allowing repeated paid work without debiting the selected budget. The corrected implementation and focused checks pass; rerun them on the current source before relying on that result. The Z3 proofs apply only to their arithmetic abstractions, not to the implementation as a whole.

## Covered code

- `packages/dispatcher/src/dispatcher.ts`: `decideDispatch`, `createReservationLedger`, `decideAndReserveDispatch`, ranking, headroom, reserve/start/release/expire/confirm.
- `packages/dispatcher/src/dispatcher-v2.ts` and `order.ts`: dispatcher ordering around v2 quotes and the string comparator; quote internals are not proven here.
- `packages/dispatcher/src/money.ts`: decimal interpretation of the legacy number inputs and conservative conversion back to numbers.
- `packages/dispatcher/data-models/dispatch.cue` and `dispatch.proto`: the accepted numeric domain.
- `packages/dispatcher/test/budget-routing.property.test.ts`: generated tests against the actual implementation.
- `packages/dispatcher/test/ledger-sequence-safety.test.ts`: exhaustion, replay, snapshot, and atomic expiry cases against the actual ledger.
- `packages/dispatcher/test/ledger-consumption-safety.test.ts`: invalid imported consumption, single restoration, and fractional-credit round trips.
- `packages/dispatcher/test/budget-category-scope.test.ts`: cross-category holds, retry checks, and reconciliation of recognizable inconsistent historical records.
- `packages/dispatcher/test/budget-estimate-routing.test.ts`: estimate-aware eligibility, fallback, and old and new replay inputs.
- `packages/dispatcher/test/dispatcher-locale.test.ts` and its fixture: process-locale and registry-order comparisons, replay, v2 ties, credit consumption, and generated string-order properties.
- `packages/ci/src/routing.ts` and `packages/stations/src/traffic-routing/control-loop.ts`: consumers; their end-to-end effects are not proven here.

## Run

From the repository root after installing workspace dependencies:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-budget-policy-routing
```

The command runs fast-check 4.x generated real-code scenarios, Z3 4.15.4 arithmetic proofs, TLC 1.7.4, and CUE sequence and consumption fixtures. Set `BUDGET_Z3_PYTHONPATH` to an existing `z3-solver==4.15.4.0` installation; otherwise the proof check downloads that version into a temporary directory. Set `TLA2TOOLS` to the pinned jar or let the shared runner download it. Java 11+, Python with pip, Node with the repo's `tsx`, Vitest, fast-check, and CUE are required. Put CUE 0.14.0 on `PATH` or set `HOBO_CUE_BIN` to its executable. Use `/statechart` to inspect the models and charts.

## Scope and evidence

The generated tests use fixed seed 614435 and 300 examples per property, including up to five providers and up to 35 reservation commands. Integer-domain tests compare selection with an independently calculated eligibility/cost oracle, check replay and registry-order invariance, and check conservation after each operation. Additional cases exercise exact cent boundaries, small prices, supplied unit prices, agreement between the account price used for selection and reservation, fine-grained credits and rate headroom, and partial settlement. Generated testing is not exhaustive.

The sequence tests use seed 614473 and 50 generated cases near `Number.MAX_SAFE_INTEGER`. They cover reserve, start, release, confirm, time advancement, expiry batches, safe replay, and rejection of unsafe imported sequence fields. The CUE fixture check accepts the maximum safe integer and rejects the next integer. The dispatcher suite passed 249 tests.

The consumption tests reject malformed or excessive free, rate, slot, and credit entries, and check release happens once. They use seed 614474 for 100 generated excessive inputs and seed 614475 for 300 generated fractional-credit snapshots produced by the ledger and reimported. The CUE fixtures independently reject excessive free, rate, and slot quantities. Runtime credit accounting subtracts remaining units with conservative upward rounding; the bound on fractional credit entries follows that arithmetic, not exact-real summation.

TLC explores 1,246 distinct states with two requests, two attempts, one provider, a two-unit budget, and unit holds. Final usage can be zero, one, or two units; the budget invariant is conditional on no provider overrun, and a running settlement requires final evidence. The model over-approximates interleavings between a snapshot and reserve; the in-memory helper is synchronous. It assumes an externally serialized/fenced ledger and valid pricing; expiry abstracts a previously advanced ledger clock. It does not check multiple providers, numeric conversions, crash recovery, external effects, CI routing, or Station cutover. The readable chart uses one request; its config is separate from the two-request safety check.

LedgerSequence explores 88 states with a maximum sequence of three and at most two pending reservations. It checks that each mutation advances the sequence, rejected exhaustion leaves time and holds unchanged, retries do not consume a sequence, and successful expiry completes its batch. The chart hides 46 same-state transitions. The model abstracts individual reserve/start/release/confirm calls as one mutation and assumes no failure other than sequence exhaustion while an expiry batch runs. Four model mutations break the respective invariants. Six implementation mutations that skip a mutation guard, omit expiry preflight, or accept unsafe snapshots fail the real-code checks.

ReservationConsumption explores 129 states for an abstract free, rate, credit, or slot quantity, requested units one or two, claimed quantities zero through two, and unique or duplicate credits. It checks the integer abstraction's restoration bound, duplicate-credit rejection, unchanged rejected snapshots, and single release. The chart hides 48 same-state transitions. Four model mutations violate those invariants; seven real-code mutations that bypass validation or individual bounds fail the tests. The model does not capture fractional rounding or authenticate the history that produced a snapshot. A forged but plausible consumption amount can still create availability unless the caller trusts or reconstructs the prior deduction.

DispatchScope explores 54 states with three categories, a shared provider identity, two requests and one unit of budget. It checks that the selected category receives the hold, accepted work is covered by that category, and an abstract recognized inconsistent snapshot stops admission. Its chart hides 27 same-state transitions. Changing the selected category or disabling the snapshot gate produces counterexamples to all three properties. The model assumes the mismatch has already been detected, prices and costs are one unit, and the ledger mutation is atomic.

The implementation regression checks all category pairs, both registry orders, optional other-category accounts, and 300 generated price/ordering cases (seed 614479). It checks valid retry, repeated admission, and wrong-dimension or underpriced pending, running, and confirmed snapshots. Five code mutations bypassing category selection, the history gate, dimension or cost checks, or retry estimate validation fail those tests. The full dispatcher suite passed 257 tests. The helper replays retained decision inputs on each call; it cannot establish the provenance of plausible values or detect old records with no replay input, and direct ledger calls bypass this gate. Affected histories and provider usage require trusted reconciliation.

EstimateRouting explores 98 states with two providers, bounded budget and estimate values, selection, reservation, and replay. It checks selected affordability, denial only when neither provider is affordable, a full estimate hold, and stable replay. The chart hides 27 same-state steps. Three model mutations produce counterexamples to four properties. The implementation tests compare selection and holds against an independent integer oracle over 300 generated scenarios (seed 614480), check a funded fallback and valid old-format replay, and catch three mutations that remove estimate-aware ranking, replay input, or the calculated price. The dispatcher suite passed 260 tests. The model abstracts free credits, switching, concurrency, CAS conflicts, rounding, and external execution.

A Z3 obligation uses unbounded nonnegative exact-real costs, budgets, and a shared estimate to prove that the abstract cheaper-first selection chooses an affordable provider whenever either is affordable and does not choose an unaffordable one. It assumes sorted candidate costs and a valid shared estimate; `BUDGET_ESTIMATE_PROOF_MUTATION=omit-estimate` yields a counterexample. It does not prove TypeScript refinement, quote accuracy, or provider behavior.

DispatchOrdering explores 48 states for two locales, tied or untied candidates, new or legacy history, and a replay on another host. It checks that new selection is locale-independent, ties record a version, and new replay is stable. The chart hides 16 same-state transitions. Three model mutations violate those properties. An executable expected counterexample shows that an unversioned legacy tie can replay differently on another locale; old histories need their original locale and may need reconciliation. The model abstracts strings and treats the detection of a relevant comparison as a boolean.

The real-code test compares English and Swedish child processes with reversed registry order, transfers a new replay input between them, checks v1/v2 tie order and equal-expiry credit consumption, and exercises 300 generated UTF-16 string triples (seed 614481). The unchanged v1 golden passes; the dispatcher suite passed 263 tests. Five implementation mutations that reintroduce locale sorting, omit the version, or change the legacy fallback fail the tests. A Z3 obligation proves that the minimum of two arbitrary integer identities is invariant under reversed input order; `DISPATCH_ORDER_PROOF_MUTATION=reverse` yields a counterexample. These checks do not prove JavaScript refinement or all pricing behavior; explicitly replayed `pricing-rating/v1` quotes retain locale-sensitive ordering.

A separate Z3 induction checks unbounded integer category identities and exact-real nonnegative liabilities, holds, caps, and costs: given a safe initial state, an affordable positive reservation, and equal selected and target categories, the updated hold covers liabilities and stays within the cap. The premises have a witness; `BUDGET_SCOPE_PROOF_MUTATION=wrong-category` produces a counterexample. The proof assumes its category equality, atomic update, and exact arithmetic, and does not prove TypeScript refinement or snapshot authenticity.

Z3 also proves by induction over unbounded nonnegative integer quantities that an abstract release gate preserves the restoration bound and cannot restore a terminal reservation twice. The proof checks its premises have witnesses; `BUDGET_CONSUMPTION_PROOF_MUTATION=omit-limit` yields a counterexample. It assumes the recorded consumption bound and a correct release gate, and does not prove fractional arithmetic, TypeScript refinement, or snapshot provenance.

The Z3 checks prove by induction that any number of exact-real reserve, pending-release, and settlement steps preserve `spent + held <= cap` from a safe initial state, provided admission uses the full nonnegative quote and final usage never exceeds its hold. It also proves a positive quote cannot be admitted at a zero cap in that abstraction. Z3 checks non-vacuous premises and finds that provider overrun can exceed the cap. This is a proof of the abstraction, not TypeScript refinement. The legacy API still returns numbers: liabilities are rounded upward and available balances downward when the exact decimal cannot be represented; this can leave a small residual hold or refuse an exactly affordable edge case. An override must be an authoritative unit quote.

The separate Z3 integer obligations prove that preflighting a nonnegative batch against remaining sequence space bounds its final and intermediate values, and distinct mutation positions have distinct sequence values. The proof checks its premises have witnesses; `BUDGET_SEQUENCE_PROOF_MUTATION=omit-preflight` yields counterexamples. It abstracts JavaScript's bounded exact integers and does not prove TypeScript refinement or storage durability. At the maximum safe sequence, even settlement must stop until a wider format is migrated and reconciled; resetting the counter would invalidate fences.

Scratch mutations removing outstanding held cost, CAS, the running-release guard, the reservation quote override, or the old numeric protection cause focused checks to fail. Model mutations removing running settlement evidence, admission fencing, or the overrun marker violate their corresponding invariants; removing the Z3 admission guard produces a counterexample. Rerun the skill against the unchanged implementation after mutation checks.

## Keep in sync

Inspect all covered code and changes since the review basis before trusting a result. When behavior changes, update the model, the proof assumptions, and the generated real-code tests; replay any model counterexample in the implementation. Re-run the check and scratch mutations, then advance the review basis only after confirming the correspondence. Use `/maintain-formal-verification-skill`.
