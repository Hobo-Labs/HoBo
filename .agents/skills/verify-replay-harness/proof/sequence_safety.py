"""Integer bounds for replay positions, assuming faithful JS classification.

The solver reasons about mathematical integers, not floating point values or
the TypeScript implementation of Number.isSafeInteger.
"""
from z3 import And, Implies, Int, Not, Solver, sat, unsat

value = Int('value')
limit = 9007199254740991
lower = value >= 0
upper = value <= limit
safe = And(lower, upper)

def check(name, assumptions, claim, expected):
    solver = Solver()
    solver.add(*assumptions, Not(claim))
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

check('accepted position lies within safe bounds', [lower, upper], safe, unsat)
check('missing lower bound permits a negative position', [upper], safe, sat)
check('missing upper bound permits an unsafe position', [lower], safe, sat)
