"""An unbounded integer abstraction of a bounded, at-most-once release."""
import os
import sys
from z3 import And, Bool, If, Implies, Ints, Not, Or, Solver, sat, unsat

units, claimed, restored = Ints("units claimed restored")
released, attempt = Bool("released"), Bool("attempt")
mutation = os.environ.get("BUDGET_CONSUMPTION_PROOF_MUTATION", "")
preconditions = [units >= 0, claimed >= 0, restored >= 0, restored <= units,
                 Implies(Not(released), restored == 0)]
if mutation != "omit-limit":
    preconditions.append(claimed <= units)
next_restored = If(And(Not(released), attempt), claimed, restored)
next_released = Or(released, attempt)

def prove(name, assumptions, conclusion):
    witness = Solver()
    witness.add(*assumptions)
    if witness.check() != sat:
        raise AssertionError(f"{name}: assumptions have no witness")
    solver = Solver()
    solver.add(*assumptions, Not(conclusion))
    result = solver.check()
    if result != unsat:
        print(f"FAIL: {name}: {result}")
        if result == sat:
            print(solver.model())
        return False
    print(f"PASS: {name}")
    return True

checks = [
    prove("release preserves the restoration bound", preconditions,
          And(next_restored >= 0, next_restored <= units)),
    prove("terminal release cannot restore again", preconditions + [released],
          next_restored == restored),
    prove("unreleased state has no prior restoration", preconditions,
          Implies(Not(next_released), next_restored == 0)),
]
if not all(checks):
    sys.exit(1)
