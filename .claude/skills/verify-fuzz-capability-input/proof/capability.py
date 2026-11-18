"""Prove abstract attenuation set properties."""
from z3 import Consts, IntSort, IsSubset, SetIntersect, SetSort, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

before, requested = Consts('before requested', SetSort(IntSort()))
after = SetIntersect(before, requested)
check('intersection never adds a verb', [~IsSubset(after, before)], unsat)
check('intersection includes only requested verbs', [~IsSubset(after, requested)], unsat)
check('using the requested set alone can widen authority', [~IsSubset(requested, before)], sat)
