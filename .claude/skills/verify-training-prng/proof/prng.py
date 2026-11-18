"""Prove abstract range and 32-bit state-step properties."""
from z3 import BitVecs, BitVecVal, Int, LShR, Reals, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.set(timeout=10000)
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

state, other = BitVecs('state other', 32)
increment = BitVecVal(0x9e3779b9, 32)
check('the 32-bit state increment is injective', [state != other, state + increment == other + increment], unsat)
steps = Int('steps')
check('the state cannot repeat before 2^32 increments',
      [steps > 0, steps < 2**32, (steps * 0x9e3779b9) % (2**32) == 0], unsat)
for multiplier, inverse in [(0x21f0aaad, 0x333c4925), (0x735a2d97, 0x97132227)]:
    check(f'multiplier {multiplier:#x} has a 32-bit inverse',
          [(state * multiplier) * inverse != state], unsat)
for shift in (15, 16):
    mixed = state ^ LShR(state, shift)
    restored = mixed ^ LShR(mixed, shift)
    if shift == 15:
        restored = restored ^ LShR(mixed, 30)
    check(f'xor-right-shift {shift} has a 32-bit inverse', [restored != state], unsat)
r, bound = Reals('r bound')
check('a nonnegative draw times a positive bound is nonnegative', [r >= 0, r < 1, bound >= 1, r * bound < 0], unsat)
check('a draw below one times a positive bound stays below the bound', [r >= 0, r < 1, bound >= 1, r * bound >= bound], unsat)
check('without a positive bound a product can be negative', [r > 0, r < 1, bound < 0, r * bound < 0], sat)
