"""Prove abstract all-pages preflight obligations."""
from z3 import Ints, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

size, scanned, bad = Ints('size scanned bad')
base = [size >= 1, scanned >= 0, scanned <= size, bad >= 1, bad <= size]
check('a completed successful scan cannot contain an invalid page', base + [scanned == size, bad > scanned], unsat)
check('a partial successful scan may still contain a later invalid page', base + [scanned < size, bad > scanned], sat)
