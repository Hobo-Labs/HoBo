"""Prove the abstract detached-view update obligation."""
from z3 import Bool, If, Ints, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

before, edited = Ints('before edited')
copied = Bool('copied')
after = If(copied, before, edited)
check('editing a detached view preserves stored state', [copied, after != before], unsat)
check('editing an aliased view can change stored state', [~copied, edited != before, after != before], sat)
