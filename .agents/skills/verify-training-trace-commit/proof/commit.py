"""Prove abstract trace-batch accounting obligations."""
from z3 import Ints, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

existing, produced, committed = Ints('existing produced committed')
check('appending a complete batch preserves prior count', [existing >= 0, produced >= 0, committed == existing + produced, committed < existing], unsat)
check('appending a complete batch preserves all new records', [existing >= 0, produced >= 0, committed == existing + produced, committed - existing != produced], unsat)
check('replacing the queue can discard existing records', [existing > 0, produced >= 0, committed == produced, committed < existing + produced], sat)
