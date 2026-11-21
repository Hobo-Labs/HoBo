"""Abstract retry-count preservation for arbitrary positive limits."""
from z3 import And, Int, Not, Solver, sat, unsat

attempts, limit = Int('attempts'), Int('limit')
initial = Solver()
initial.add(limit >= 1, Not(0 <= limit))
if initial.check() != unsat:
    raise AssertionError('the initial retry count must be in range')
print('Proved: the initial retry count is in range')
claim = attempts + 1 <= limit
for guarded in (True, False):
    solver = Solver()
    solver.add(limit >= 1, attempts >= 0)
    if guarded:
        solver.add(attempts < limit)
    solver.add(Not(claim))
    expected = unsat if guarded else sat
    if solver.check() != expected:
        raise AssertionError('unexpected retry-bound result')
    print('Proved: a guarded retry stays within its limit' if guarded else 'Expected counterexample: retry without a bound')
