"""Prove inductive safety of an exact-arithmetic budget abstraction with Z3."""

import os
import sys

from z3 import And, Not, Real, Solver, sat, unsat, get_version_string


if get_version_string() != "4.15.4":
    raise SystemExit(f"expected Z3 4.15.4, got {get_version_string()}")

cap, spent, held, quote, released, actual = [
    Real(name) for name in ("cap", "spent", "held", "quote", "released", "actual")
]


def invariant(new_spent, new_held):
    return And(cap >= 0, new_spent >= 0, new_held >= 0, new_spent + new_held <= cap)


def prove(name, assumptions, conclusion):
    witness = Solver()
    witness.add(*assumptions)
    if witness.check() != sat:
        raise RuntimeError(f"{name}: assumptions are unsatisfiable or unknown")
    solver = Solver()
    solver.add(*assumptions, Not(conclusion))
    result = solver.check()
    if result != unsat:
        print(f"FAIL {name}: {result}")
        if result == sat:
            print(solver.model())
        return False
    print(f"PASS {name}: all exact real values satisfying the assumptions")
    return True


base = [cap >= 0]
state = invariant(spent, held)
mutation = os.environ.get("BUDGET_PROOF_MUTATION") == "omit-reserve-budget-guard"
reserve = [state, quote >= 0]
if not mutation:
    reserve.append(quote <= cap - spent - held)

checks = [
    prove("initial state", base, invariant(0, 0)),
    prove("admission", reserve, invariant(spent, held + quote)),
    prove("release pending hold", [state, released >= 0, released <= held], invariant(spent, held - released)),
    prove(
        "settle within hold",
        [state, released >= 0, released <= held, actual >= 0, actual <= released],
        invariant(spent + actual, held - released),
    ),
    prove(
        "positive quote cannot fit zero budget",
        [state, cap == 0, quote > 0],
        Not(quote <= cap - spent - held),
    ),
]

# A real provider's final bill can exceed a hold; the implementation records
# that truthfully. It is deliberately outside the inductive cap guarantee.
overrun = Solver()
overrun.add(state, released > 0, released <= held, actual > released, spent + actual + held - released > cap)
if overrun.check() != sat:
    raise RuntimeError("expected an unbounded-cost overrun counterexample")
print("SCOPE: actual cost above a hold can exceed the cap; it is not covered")
sys.exit(0 if all(checks) else 1)
