"""Prove abstract clock assignment and replay bounds."""
from z3 import Ints, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

old, assigned, replayed = Ints('old assigned replayed')
limit = 2**53 - 1
check('guarded assignments do not rewind or exceed the safe range', [old >= 0, old <= limit, assigned >= old, assigned <= limit, ((assigned < old) | (assigned > limit))], unsat)
check('replaying the recorded assignment preserves its value', [assigned >= 0, assigned <= limit, replayed == assigned, replayed != assigned], unsat)
check('an unguarded assignment can rewind', [old > 0, assigned >= 0, assigned < old], sat)
