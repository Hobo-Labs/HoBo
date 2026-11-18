"""Arithmetic implications of the accepted visible journal prefix."""
from z3 import Ints, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

i, j, seq_i, seq_j = Ints('i j seq_i seq_j')
order = [i >= 0, j > i, seq_i == i + 1, seq_j == j + 1]
check('contiguous positions strictly increase for arbitrary indices', order + [seq_j <= seq_i], unsat)
check('contiguous positions have exactly the corresponding distance', order + [seq_j - seq_i != j - i], unsat)
check('without the second position check a gap is possible', [i >= 0, j > i, seq_i == i + 1, seq_j > j + 1], sat)

terminal, last = Ints('terminal last')
check('a terminal with no following index is the last record', [terminal >= 0, terminal <= last, terminal + 1 > last, terminal != last], unsat)
check('without the terminal check a following record is possible', [terminal >= 0, terminal < last], sat)
