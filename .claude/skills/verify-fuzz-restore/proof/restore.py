"""Prove the abstract replacement-clock arithmetic."""
from z3 import If, Ints, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

old, source = Ints('old source')
limit = 2**53 - 1
maximum = If(old > source, old, source)
assumptions = [old >= 0, source >= 0, old < limit, source < limit]
check('replacement clock advances beyond both inputs', assumptions + [((maximum + 1 <= old) | (maximum + 1 <= source))], unsat)
check('guarded replacement remains within the safe integer range', assumptions + [maximum + 1 > limit], unsat)
check('an exhausted source prevents a safe replacement clock', [old >= 0, old <= limit, source == limit, maximum + 1 > limit], sat)
