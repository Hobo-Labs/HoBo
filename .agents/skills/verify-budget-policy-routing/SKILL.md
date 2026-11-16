---
name: verify-budget-policy-routing
description: Verify credit and hard-budget dispatch selection and reservation accounting when changing the dispatcher, its contracts, or its callers.
---

# Budget-policy routing

**Properties:** With valid inputs and an authoritative quote, admission must not understate paid exposure or exceed the hard budget. Pending releases and bounded final settlements must not create funds, free credits, or slots. Given identical snapshots, provider choice is deterministic.

**Why:** Wrong routing can either launch paid work without an adequate hold or refuse work the customer can afford.

**Review basis:** commit `b32b66195e2bc63550a0a66c25638c36e98fec61`. Before the corrections, the implementation failed on exact-cent affordability and a positive charge rounded to zero. The corrected implementation and focused checks pass; rerun them on the current source before relying on that result. The separate Z3 proof applies only to its exact-arithmetic abstraction, not to JavaScript numbers or the implementation as a whole.

## Covered code

- `packages/dispatcher/src/dispatcher.ts`: `decideDispatch`, `createReservationLedger`, `decideAndReserveDispatch`, ranking, headroom, reserve/start/release/expire/confirm.
- `packages/dispatcher/src/money.ts`: decimal interpretation of the legacy number inputs and conservative conversion back to numbers.
- `packages/dispatcher/data-models/dispatch.cue` and `dispatch.proto`: the accepted numeric domain.
- `packages/dispatcher/test/budget-routing.property.test.ts`: generated tests against the actual implementation.
- `packages/ci/src/routing.ts` and `packages/stations/src/traffic-routing/control-loop.ts`: consumers; their end-to-end effects are not proven here.

## Run

From the repository root after installing workspace dependencies:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-budget-policy-routing
```

The command runs fast-check 4.x generated real-code scenarios, a Z3 4.15.4 exact-real inductive proof, and TLC 1.7.4. Set `BUDGET_Z3_PYTHONPATH` to an existing `z3-solver==4.15.4.0` installation; otherwise the proof check downloads that version into a temporary directory. Set `TLA2TOOLS` to the pinned jar or let the shared runner download it. Java 11+, Python with pip, Node with the repo's `tsx`, Vitest, and fast-check are required. Use `/statechart` to inspect the model and chart.

## Scope and evidence

The generated tests use fixed seed 614435 and 300 examples per property, including up to five providers and up to 35 reservation commands. Integer-domain tests compare selection with an independently calculated eligibility/cost oracle, check replay and registry-order invariance, and check conservation after each operation. Additional cases exercise exact cent boundaries, small prices, supplied unit prices, agreement between the account price used for selection and reservation, fine-grained credits and rate headroom, and partial settlement. Generated testing is not exhaustive.

TLC explores 1,246 distinct states with two requests, two attempts, one provider, a two-unit budget, and unit holds. Final usage can be zero, one, or two units; the budget invariant is conditional on no provider overrun, and a running settlement requires final evidence. The model over-approximates interleavings between a snapshot and reserve; the in-memory helper is synchronous. It assumes an externally serialized/fenced ledger and valid pricing; expiry abstracts a previously advanced ledger clock. It does not check multiple providers, numeric conversions, crash recovery, external effects, CI routing, or Station cutover. The readable chart uses one request; its config is separate from the two-request safety check.

The Z3 checks prove by induction that any number of exact-real reserve, pending-release, and settlement steps preserve `spent + held <= cap` from a safe initial state, provided admission uses the full nonnegative quote and final usage never exceeds its hold. It also proves a positive quote cannot be admitted at a zero cap in that abstraction. Z3 checks non-vacuous premises and finds that provider overrun can exceed the cap. This is a proof of the abstraction, not TypeScript refinement. The legacy API still returns numbers: liabilities are rounded upward and available balances downward when the exact decimal cannot be represented; this can leave a small residual hold or refuse an exactly affordable edge case. An override must be an authoritative unit quote.

Scratch mutations removing outstanding held cost, CAS, the running-release guard, the reservation quote override, or the old numeric protection cause focused checks to fail. Model mutations removing running settlement evidence, admission fencing, or the overrun marker violate their corresponding invariants; removing the Z3 admission guard produces a counterexample. Rerun the skill against the unchanged implementation after mutation checks.

## Keep in sync

Inspect all covered code and changes since the review basis before trusting a result. When behavior changes, update the model, the proof assumptions, and the generated real-code tests; replay any model counterexample in the implementation. Re-run the check and scratch mutations, then advance the review basis only after confirming the correspondence. Use `/maintain-formal-verification-skill`.
