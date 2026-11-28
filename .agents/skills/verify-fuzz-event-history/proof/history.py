"""Prove abstract live/replay revision accounting for custom events."""
from z3 import Ints, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

start, count, live, replay = Ints('start count live replay')
check('matching event counts yield matching revisions', [start >= 0, count >= 0, live == start + count, replay == start + count, live != replay], unsat)
check('omitting a live tick causes revision divergence', [start >= 0, count > 0, live == start + count - 1, replay == start + count, live != replay], sat)
