"""Prove fixed-offset budget safety for an exact-arithmetic broker abstraction."""

import os
import sys

from z3 import And, Not, Real, Solver, sat, unsat, get_version_string

if get_version_string() != "4.15.4":
    raise SystemExit(f"expected Z3 4.15.4, got {get_version_string()}")

cap, spent, held, unresolved, recovery, external, quote, released, actual = [
    Real(name)
    for name in (
        "cap", "spent", "held", "unresolved", "recovery", "external",
        "quote", "released", "actual",
    )
]
offsets = unresolved + recovery + external


def invariant(new_spent, new_held):
    return And(
        cap >= 0, new_spent >= 0, new_held >= 0, unresolved >= 0,
        recovery >= 0, external >= 0, new_spent + new_held + offsets <= cap,
    )


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


state = invariant(spent, held)
admission_offset = recovery + external
if os.environ.get("BROKER_PROOF_MUTATION") != "omit-unresolved":
    admission_offset += unresolved

checks = [
    prove(
        "initial state with covered outside commitments",
        [unresolved >= 0, recovery >= 0, external >= 0, offsets <= cap],
        invariant(0, 0),
    ),
    prove(
        "admit complete liability bound",
        [state, quote >= 0, spent + held + admission_offset + quote <= cap],
        invariant(spent, held + quote),
    ),
    prove(
        "release unused liability",
        [state, released >= 0, released <= held],
        invariant(spent, held - released),
    ),
    prove(
        "settle actual usage within its hold",
        [state, released >= 0, released <= held, actual >= 0, actual <= released],
        invariant(spent + actual, held - released),
    ),
]

overrun = Solver()
overrun.add(state, released > 0, released <= held, actual > released,
            spent + actual + held - released + offsets > cap)
if overrun.check() != sat:
    raise RuntimeError("expected an overrun counterexample")
print("SCOPE: provider overruns and changes to outside exposure are not covered")
sys.exit(0 if all(checks) else 1)
