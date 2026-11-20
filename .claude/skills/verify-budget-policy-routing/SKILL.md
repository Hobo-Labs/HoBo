---
name: verify-budget-policy-routing
description: Verify credit and hard-budget dispatch selection and reservation accounting when changing the dispatcher, its contracts, or its callers.
---

# Budget-policy routing

**Properties:** With valid inputs and an authoritative quote, admission must not understate paid exposure or exceed the hard budget. Pending releases and bounded final settlements must not create funds, free credits, or slots. Imported consumption is checked against reserved units and slot count. Given identical snapshots, provider choice is deterministic. Ledger mutations cannot reuse an unsafe sequence, and sequence exhaustion cannot partially expire a batch.

**Why:** Wrong routing can either launch paid work without an adequate hold or refuse work the customer can afford.

**Review basis:** commit `5a5fab8e7765e00763a0f3c7cebfd70ff33e78a1`. Before the corrections, the implementation failed on exact-cent affordability, a positive charge rounded to zero, sequence exhaustion, and excessive imported consumption. The corrected implementation and focused checks pass; rerun them on the current source before relying on that result. The Z3 proofs apply only to their arithmetic abstractions, not to JavaScript numbers or the implementation as a whole.

## Covered code

- `packages/dispatcher/src/dispatcher.ts`: `decideDispatch`, `createReservationLedger`, `decideAndReserveDispatch`, ranking, headroom, reserve/start/release/expire/confirm.
- `packages/dispatcher/src/money.ts`: decimal interpretation of the legacy number inputs and conservative conversion back to numbers.
- `packages/dispatcher/data-models/dispatch.cue` and `dispatch.proto`: the accepted numeric domain.
- `packages/dispatcher/test/budget-routing.property.test.ts`: generated tests against the actual implementation. `budget-safety.test.ts` and `money-overflow.test.ts` check estimate admission, finite accounting, and refusal without mutation when a hold or settlement cannot be represented.
- `packages/dispatcher/test/ledger-sequence-safety.test.ts`: exhaustion, replay, snapshot, and atomic expiry cases against the actual ledger.
- `packages/dispatcher/test/ledger-consumption-safety.test.ts`: invalid imported consumption, single restoration, and fractional-credit round trips.
- `packages/ci/src/routing.ts` and `packages/stations/src/traffic-routing/control-loop.ts`: consumers; their end-to-end effects are not proven here.

## Run

From the repository root after installing workspace dependencies:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-budget-policy-routing
```

The command runs fast-check 4.x generated real-code scenarios, Z3 4.15.4 arithmetic proofs, TLC 1.7.4, and CUE sequence and consumption fixtures. Set `BUDGET_Z3_PYTHONPATH` to an existing `z3-solver==4.15.4.0` installation; otherwise the proof check downloads that version into a temporary directory. Set `TLA2TOOLS` to the pinned jar or let the shared runner download it. Java 11+, Python with pip, Node with the repo's `tsx`, Vitest, fast-check, and CUE are required. Put CUE 0.14.0 on `PATH` or set `HOBO_CUE_BIN` to its executable. Use `/statechart` to inspect the models and charts.

## Scope and evidence

The generated tests use fixed seed 614435 and 300 examples per property, including up to five providers and up to 35 reservation commands. Integer-domain tests compare selection with an independently calculated eligibility/cost oracle, check replay and registry-order invariance, and check conservation after each operation. Additional cases exercise exact cent boundaries, small prices, supplied unit prices, agreement between the account price used for selection and reservation, fine-grained credits and rate headroom, and partial settlement. The verification command also runs the hard-budget and overflow regression suites. Generated testing is not exhaustive.

The sequence tests use seed 614473 and 50 generated cases near `Number.MAX_SAFE_INTEGER`. They cover reserve, start, release, confirm, time advancement, expiry batches, safe replay, and rejection of unsafe imported sequence fields. The CUE fixture check accepts the maximum safe integer and rejects the next integer. The dispatcher suite passed 249 tests.

The consumption tests reject malformed or excessive free, rate, slot, and credit entries, and check release happens once. They use seed 614474 for 100 generated excessive inputs and seed 614475 for 300 generated fractional-credit snapshots produced by the ledger and reimported. The CUE fixtures independently reject excessive free, rate, and slot quantities. Runtime credit accounting subtracts remaining units with conservative upward rounding; the bound on fractional credit entries follows that arithmetic, not exact-real summation.

TLC explores 1,246 distinct states with two requests, two attempts, one provider, a two-unit budget, and unit holds. Final usage can be zero, one, or two units; the budget invariant is conditional on no provider overrun, and a running settlement requires final evidence. The model over-approximates interleavings between a snapshot and reserve; the in-memory helper is synchronous. It assumes an externally serialized/fenced ledger and valid pricing; expiry abstracts a previously advanced ledger clock. It does not check multiple providers, numeric conversions or overflow, crash recovery, external effects, CI routing, or Station cutover. The TypeScript overflow regressions test those concrete cases; the finite model does not prove them. The readable chart uses one request; its config is separate from the two-request safety check.

LedgerSequence explores 88 states with a maximum sequence of three and at most two pending reservations. It checks that each mutation advances the sequence, rejected exhaustion leaves time and holds unchanged, retries do not consume a sequence, and successful expiry completes its batch. The chart hides 46 same-state transitions. The model abstracts individual reserve/start/release/confirm calls as one mutation and assumes no failure other than sequence exhaustion while an expiry batch runs. Four model mutations break the respective invariants. Six implementation mutations that skip a mutation guard, omit expiry preflight, or accept unsafe snapshots fail the real-code checks.

ReservationConsumption explores 129 states for an abstract free, rate, credit, or slot quantity, requested units one or two, claimed quantities zero through two, and unique or duplicate credits. It checks the integer abstraction's restoration bound, duplicate-credit rejection, unchanged rejected snapshots, and single release. The chart hides 48 same-state transitions. Four model mutations violate those invariants; seven real-code mutations that bypass validation or individual bounds fail the tests. The model does not capture fractional rounding or authenticate the history that produced a snapshot. A forged but plausible consumption amount can still create availability unless the caller trusts or reconstructs the prior deduction.

Z3 also proves by induction over unbounded nonnegative integer quantities that an abstract release gate preserves the restoration bound and cannot restore a terminal reservation twice. The proof checks its premises have witnesses; `BUDGET_CONSUMPTION_PROOF_MUTATION=omit-limit` yields a counterexample. It assumes the recorded consumption bound and a correct release gate, and does not prove fractional arithmetic, TypeScript refinement, or snapshot provenance.

The Z3 checks prove by induction that any number of exact-real reserve, pending-release, and settlement steps preserve `spent + held <= cap` from a safe initial state, provided admission uses the full nonnegative quote and final usage never exceeds its hold. It also proves a positive quote cannot be admitted at a zero cap in that abstraction. Z3 checks non-vacuous premises and finds that provider overrun can exceed the cap. This is a proof of the abstraction, not TypeScript refinement. The legacy API still returns numbers: liabilities are rounded upward and available balances downward when the exact decimal cannot be represented; this can leave a small residual hold or refuse an exactly affordable edge case. An override must be an authoritative unit quote.

The separate Z3 integer obligations prove that preflighting a nonnegative batch against remaining sequence space bounds its final and intermediate values, and distinct mutation positions have distinct sequence values. The proof checks its premises have witnesses; `BUDGET_SEQUENCE_PROOF_MUTATION=omit-preflight` yields counterexamples. It abstracts JavaScript's bounded exact integers and does not prove TypeScript refinement or storage durability. At the maximum safe sequence, even settlement must stop until a wider format is migrated and reconciled; resetting the counter would invalidate fences.

Scratch mutations removing outstanding held cost, CAS, the running-release guard, the reservation quote override, or the old numeric protection caused focused checks to fail during development. The maintained mutation command below checks five overflow and estimate regressions in scratch copies, then reruns the restored skill. It requires the same dependencies as the main command.

```sh
python3 .agents/skills/verify-budget-policy-routing/mutations/full.py
```
The main verification command also checks that three weakened models yield counterexamples when running settlement evidence, both admission fences, or the overrun marker are removed; removing the Z3 admission guard produces a counterexample. Rerun the skill against the unchanged implementation after mutation checks.

## Keep in sync

Inspect all covered code and changes since the review basis before trusting a result. When behavior changes, update the model, the proof assumptions, and the generated real-code tests; replay any model counterexample in the implementation. Re-run the check and scratch mutations, then advance the review basis only after confirming the correspondence. Use `/maintain-formal-verification-skill`.
