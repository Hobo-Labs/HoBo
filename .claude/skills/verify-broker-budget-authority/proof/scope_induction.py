"""Prove active-claim scope preservation for an equality-only abstraction."""

import os
import sys

from z3 import And, Bool, Implies, Ints, Not, Or, Solver, get_version_string, sat, unsat

if get_version_string() != "4.15.4":
    raise SystemExit(f"expected Z3 4.15.4, got {get_version_string()}")

active = Bool("active")
bucket_unit, bucket_period, claim_unit, claim_period, next_unit, next_period = Ints(
    "bucket_unit bucket_period claim_unit claim_period next_unit next_period",
)


def safe(is_active, unit, period, bound_unit, bound_period):
    return Implies(is_active, And(unit == bound_unit, period == bound_period))


def prove(name, assumptions, conclusion):
    witness = Solver()
    witness.add(*assumptions)
    witness_result = witness.check()
    if witness_result == sat:
        pass
    elif witness_result != unsat:
        raise RuntimeError(f"{name}: assumptions are unknown")
    else:
        raise RuntimeError(f"{name}: assumptions are unsatisfiable")
    solver = Solver()
    solver.add(*assumptions, Not(conclusion))
    result = solver.check()
    if result == unsat:
        print(f"PASS {name}: all abstract scope values satisfying the assumptions")
        return True
    if result == sat:
        print(f"FAIL {name}: sat")
        print(solver.model())
        return False
    raise RuntimeError(f"{name}: solver returned unknown")


mutation = os.environ.get("BROKER_SCOPE_PROOF_MUTATION")
configure_guards = []
replay_guards = []
if mutation != "omit-unit":
    configure_guards.append(Implies(active, next_unit == bucket_unit))
    replay_guards.append(Implies(active, next_unit == claim_unit))
if mutation != "omit-period":
    configure_guards.append(Implies(active, next_period == bucket_period))
    replay_guards.append(Implies(active, next_period == claim_period))
if mutation != "omit-unit":
    configure_guards.append(Implies(Not(active), next_unit == bucket_unit))
if mutation != "omit-period":
    configure_guards.append(Implies(Not(active), next_period == bucket_period))

state = safe(active, bucket_unit, bucket_period, claim_unit, claim_period)
checks = [
    prove(
        "admit claim in the observed scope",
        [
            Not(active),
            claim_unit == bucket_unit,
            claim_period == bucket_period,
            next_unit == bucket_unit,
            next_period == bucket_period,
        ],
        And(next_unit == claim_unit, next_period == claim_period),
    ),
    prove(
        "revise scope while retaining active claims",
        [active, state, *configure_guards],
        And(next_unit == claim_unit, next_period == claim_period),
    ),
    prove(
        "accept compatible replay",
        [active, state, *replay_guards],
        And(next_unit == claim_unit, next_period == claim_period),
    ),
    prove(
        "remove a terminal claim from the active projection",
        [
            Not(active),
            claim_unit == bucket_unit,
            claim_period == bucket_period,
            *configure_guards,
        ],
        And(next_unit == claim_unit, next_period == claim_period),
    ),
]
sys.exit(0 if all(checks) else 1)