"""Prove the abstract guards for consuming a workflow step journal."""
from z3 import And, Bool, Implies, Int, Not, Solver, sat, unsat

max_index, consumed, failure_index = Int('max_index'), Int('consumed'), Int('failure_index')
terminal, accepted = Bool('terminal'), Bool('accepted')

def check(label, guards, claim, expected):
    solver = Solver()
    solver.add(*guards, Not(claim))
    result = solver.check()
    if result != expected:
        raise AssertionError(f'{label}: expected {expected}, got {result}')
    print(f'{label}: {result}')

check(
    'terminal requires every recorded outcome to be consumed',
    [terminal == (consumed > max_index)],
    Implies(terminal, consumed > max_index),
    unsat,
)
check(
    'missing consumption guard permits a terminal with pending outcomes',
    [terminal, consumed <= max_index],
    Implies(terminal, consumed > max_index),
    sat,
)
post_failure = And(failure_index >= 0, failure_index < max_index)
check(
    'an outcome after failure is refused',
    [accepted == Not(post_failure)],
    Implies(accepted, Not(post_failure)),
    unsat,
)
check(
    'missing post-failure guard accepts an impossible history',
    [accepted, post_failure],
    Implies(accepted, Not(post_failure)),
    sat,
)
