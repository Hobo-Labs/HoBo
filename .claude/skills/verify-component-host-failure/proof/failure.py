"""Abstract fail-closed and active-call fence obligations."""
from z3 import And, Bool, Ints, Not, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

failed, poisoned, guard, operation = [Bool(n) for n in ('failed', 'poisoned', 'guard', 'operation')]
allowed = Not(And(guard, poisoned))
check('a poisoned guarded host refuses a later operation', [failed, poisoned, guard, allowed, operation], unsat)
check('without entry guard an operation can follow failure', [failed, poisoned, Not(guard), allowed, operation], sat)
busy, busy_guard, teardown = [Bool(n) for n in ('busy', 'busy_guard', 'teardown')]
check('a busy guarded component cannot be torn down', [busy, busy_guard, teardown, Not(And(busy_guard, busy))], unsat)
check('without a busy guard teardown can race a call', [busy, Not(busy_guard), teardown, Not(And(busy_guard, busy))], sat)

pending, fence = Ints('pending fence')
check('settling a call preserves a matching count', [pending > 0, fence == pending, fence - 1 != pending - 1], unsat)
check('settling one of two or more leaves a positive fence', [pending >= 2, fence == pending, fence - 1 <= 0], unsat)
check('without release the count can differ after settlement', [pending > 0, fence == pending, fence != pending - 1], sat)
