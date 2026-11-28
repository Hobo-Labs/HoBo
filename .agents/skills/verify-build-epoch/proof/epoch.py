"""Prove abstract integer arithmetic used by build-epoch normalization."""
from z3 import Ints, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

seconds, fraction = Ints('seconds fraction')
limit = 8_640_000_000_000
max_safe = 2**53 - 1
check('accepted numeric seconds convert to an exactly representable integer millisecond', [seconds >= 0, seconds <= limit, seconds * 1000 > max_safe], unsat)
check('integer division recovers accepted whole seconds', [seconds >= 0, seconds <= limit, (seconds * 1000) / 1000 != seconds], unsat)
check('fractional milliseconds round down to their second', [seconds >= 0, seconds <= 253_402_387_139, fraction >= 0, fraction < 1000, (seconds * 1000 + fraction) / 1000 != seconds], unsat)
check('unbounded numeric seconds can exceed the exact integer range', [seconds > limit, seconds * 1000 > max_safe], sat)
