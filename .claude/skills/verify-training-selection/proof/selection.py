"""Prove abstract best-score and two-reward mean obligations."""
from z3 import If, Ints, Reals, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

best, score = Reals('best score')
previous, current = Ints('previous current')
next_best = If(score > best, score, best)
next_index = If(score > best, current, previous)
check('keep-best never regresses', [next_best < best], unsat)
check('keep-best is at least the proposal', [next_best < score], unsat)
check('a tie retains the previous candidate', [score == best, next_index != previous], unsat)
check('replacing on ties can select a different candidate', [score == best, current != previous], sat)
a, b = Reals('a b')
mean = (a + b) / 2
check('the mean of two in-range rewards remains in range', [a >= 0, a <= 1, b >= 0, b <= 1, (mean < 0) | (mean > 1)], unsat)
