"""Prove abstract ownership and draining guards over arbitrary integers.

This is not a proof of the runtime, storage identity, or cross-process mutual
exclusion. It assumes an indivisible local map entry and truthful counters.
"""
from z3 import And, Bool, Implies, Int, Not, Or, Solver, sat, unsat

first, retry, owner = Int('first'), Int('retry'), Int('owner')
pending = Int('pending')
first_live, retry_live, finished = Bool('first_live'), Bool('retry_live'), Bool('finished')


def check(name, assumptions, claim, expected=unsat):
    solver = Solver()
    solver.add(*assumptions, Not(claim))
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")


owners = [first != retry, Implies(first_live, owner == first), Implies(retry_live, owner == retry)]
check('distinct live executions cannot share one owner', owners, Not(And(first_live, retry_live)))
check('missing ownership guard', owners[:-1], Not(And(first_live, retry_live)), sat)
drop = And(finished, pending == 0)
check('a positive pending count keeps the lease', [pending >= 0, pending > 0], Not(drop))
early_drop = finished
check('releasing at parent exit can drop a live command', [pending > 0], Not(early_drop), sat)
