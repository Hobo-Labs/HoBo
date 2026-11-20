"""Check abstract guards for consuming outcomes and handling failures."""
from z3 import Bool, Implies, Int, Not, Solver, sat, unsat

max_index, consumed, failure_index = Int('max_index'), Int('consumed'), Int('failure_index')
terminal, completed, caught = Bool('terminal'), Bool('completed'), Bool('caught')

def check(label, guards, claim, expected):
    solver = Solver()
    solver.add(*guards, Not(claim))
    result = solver.check()
    if result != expected:
        raise AssertionError(f'{label}: expected {expected}, got {result}')
    print(f'{label}: {result}')

check(
    'terminal requires every recorded outcome to be consumed',
    [Implies(terminal, consumed > max_index)],
    Implies(terminal, consumed > max_index),
    unsat,
)
check(
    'missing consumption guard permits a terminal with pending outcomes',
    [terminal, consumed <= max_index],
    Implies(terminal, consumed > max_index),
    sat,
)
check(
    'completion after replayed failure requires the failure to be caught',
    [failure_index >= 0, failure_index <= max_index,
     Implies(completed, consumed > max_index),
     Implies(consumed > failure_index, caught)],
    Implies(completed, caught),
    unsat,
)
solver = Solver()
solver.add(failure_index == 0, max_index == 1, consumed == 2, caught, completed)
if solver.check() != sat:
    raise AssertionError('caught failure followed by compensation must be possible')
print('caught failure followed by compensation: sat')
