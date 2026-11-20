"""Inductively prove a stable single-key request binding abstraction."""
import os
import sys
from z3 import And, Bool, If, Implies, Ints, Not, Solver, get_version_string, sat, unsat

if get_version_string() != "4.15.4":
    raise SystemExit(f"expected Z3 4.15.4, got {get_version_string()}")

stored, accepted_request, candidate = Ints("stored accepted_request candidate")
empty, accepted = Bool("empty"), Bool("accepted")


def invariant(is_empty, identity, was_accepted, accepted_identity):
    return Implies(was_accepted, And(Not(is_empty), accepted_identity == identity))


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
    print(f"PASS {name}: all identities satisfying the assumptions")
    return True


state = invariant(empty, stored, accepted, accepted_request)
claimed = If(empty, candidate, stored)
checks = [
    prove("new key has no acknowledged request", [], invariant(True, stored, False, accepted_request)),
    prove("atomic claim preserves earlier acknowledgements", [state],
          invariant(False, claimed, accepted, accepted_request)),
]
guard = [Not(empty)]
if os.environ.get("PROMOTION_PROOF_MUTATION") != "omit-binding-check":
    guard.append(candidate == stored)
checks.append(prove("acknowledgement matches claimed identity", [state, *guard],
                    invariant(empty, stored, True, candidate)))
print("SCOPE: assumes atomic claim and stable identity; not an implementation or external-effect proof")
sys.exit(0 if all(checks) else 1)
