"""Prove a monotone pilot gate for any abstract number of camps and starts."""

import os
import sys

from z3 import And, Bool, If, Implies, Ints, Not, Or, Solver, sat, unsat, get_version_string

if get_version_string() != "4.15.4":
    raise SystemExit(f"expected Z3 4.15.4, got {get_version_string()}")

mandatory, succeeded, production = Ints("mandatory succeeded production")
halted = Bool("halted")
started = Bool("started")
catchup = Bool("catchup")


def invariant(successes, starts):
    return And(mandatory >= 0, successes >= 0, successes <= mandatory,
               starts >= 0, Or(starts == 0, successes == mandatory))


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


state = invariant(succeeded, production)
start = [state, Not(halted)]
if os.environ.get("FANOUT_PROOF_MUTATION") != "omit-pilot-gate":
    start.append(succeeded == mandatory)
catchup_start = [state, Not(halted), catchup]
if os.environ.get("FANOUT_PROOF_MUTATION") != "omit-catchup-gate":
    catchup_start.append(succeeded == mandatory)
halt_guard = []
if os.environ.get("FANOUT_PROOF_MUTATION") != "omit-halt-guard":
    halt_guard.append(Implies(started, Not(halted)))
checks = [
    prove("new fanout", [mandatory >= 0], invariant(0, 0)),
    prove("mandatory camp succeeds", [state, succeeded < mandatory],
          invariant(succeeded + 1, production)),
    prove("production starts only after mandatory success", start,
          invariant(succeeded, production + 1)),
    prove("catch-up production starts only after mandatory success", catchup_start,
          invariant(succeeded, production + 1)),
    prove("halt prevents a new start", [state, *halt_guard],
          Implies(halted, If(started, production + 1, production) == production)),
    prove("halt, resume or idle retain progress", [state],
          invariant(succeeded, production)),
]
print("SCOPE: assumes monotone pilot success within one run, a gate in both modes, and atomic scheduling")
sys.exit(0 if all(checks) else 1)
