"""Prove abstract integer bounds for the reference model revision clock."""
from z3 import Int, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

clock = Int('clock')
limit = 2**53 - 1
check('a guarded increment remains an exact nonnegative integer', [clock >= 0, clock < limit, (clock + 1 > limit)], unsat)
check('a guarded increment strictly advances', [clock >= 0, clock < limit, clock + 1 <= clock], unsat)
check('an unguarded increment can exceed the safe integer range', [clock == limit, clock + 1 > limit], sat)
