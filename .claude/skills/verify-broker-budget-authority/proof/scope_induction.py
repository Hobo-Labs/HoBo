"""Prove active-claim scope preservation for an equality-only abstraction."""

import os
import sys

from z3 import And, Bool, Implies, Ints, Not, Solver, get_version_string, sat, unsat

if get_version_string() != "4.15.4":
    raise SystemExit(f"expected Z3 4.15.4, got {get_version_string()}")

active = Bool("active")
bucket_unit, bucket_period, claim_unit, claim_period, next_unit, next_period = Ints(
    "bucket_unit bucket_period claim_unit claim_period next_unit next_period"
)


def safe(is_active, unit, period, bound_unit, bound_period):
    return Implies(is_active, And(unit == bound_unit, period == bound_period))


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
    print(f"PASS {name}: all abstract scope values satisfying the assumptions")
    return True


mutation = os.environ.get("BROKER_SCOPE_PROOF_MUTATION")
configure_guards = []
replay_guards = []
if mutation != "omit-unit":
    configure_guards.append(Implies(active, next_unit == bucket_unit))
    replay_guards.append(Implies(active, next_unit == claim_unit))
if mutation != "omit-period":
    configure_guards.append(Implies(active, next_period == bucket_period))
    replay_guards.append(Implies(active, next_period == claim_period))

state = safe(active, bucket_unit, bucket_period, claim_unit, claim_period)
checks = [
    prove("admit claim in the observed scope", [Not(active)],
          safe(True, bucket_unit, bucket_period, bucket_unit, bucket_period)),
    prove("revise scope while retaining active claims", [state, *configure_guards],
          safe(active, next_unit, next_period, claim_unit, claim_period)),
    prove("accept compatible replay", replay_guards,
          safe(active, next_unit, next_period, claim_unit, claim_period)),
    prove("remove a terminal claim from the active projection", [state],
          safe(False, bucket_unit, bucket_period, claim_unit, claim_period)),
]
sys.exit(0 if all(checks) else 1)
