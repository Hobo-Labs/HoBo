"""Prove policy admission obligations for unbounded nonnegative integers."""
import os
import sys
from z3 import And, Bool, Implies, Ints, Not, Or, Solver, get_version_string, sat, unsat

if get_version_string() != "4.15.4":
    raise SystemExit(f"expected Z3 4.15.4, got {get_version_string()}")

cap, exposure, cost, start, now, duration, end = Ints(
    "cap exposure cost start now duration end"
)
strict, native, planning = Bool("strict"), Bool("native"), Bool("planning")
scope_ok, window_ok, metrics_ok = Bool("scope_ok"), Bool("window_ok"), Bool("metrics_ok")
mutation = os.environ.get("SHARED_POLICY_PROOF_MUTATION")


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
    print(f"PASS {name}: all integers satisfying the assumptions")
    return True


amount_guard = exposure + (0 if mutation == "omit-cost" else cost) <= cap
native_guard = Or(Not(strict), native, planning) if mutation != "omit-native" else True
feasible = And(scope_ok, window_ok, metrics_ok, amount_guard, native_guard)
checks = [
    prove("admission covers exposure and bound", [cap >= 0, exposure >= 0, cost >= 0, amount_guard],
          And(exposure + cost <= cap, cap - exposure - cost >= 0)),
    prove("strict admission needs native provenance", [feasible, strict, Not(planning)], native),
    prove("funded window covers work", [start >= 0, now >= start, duration >= 0,
          end > start, now < end, now + duration <= end],
          And(end - now >= 0, duration <= end - now)),
]
print("SCOPE: trusted inputs, exact integers, and atomic evaluation; not implementation refinement or provider authentication")
sys.exit(0 if all(checks) else 1)
