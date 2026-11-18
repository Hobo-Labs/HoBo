"""Prove abstract uint32 loop arithmetic and a binary64 boundary example."""
from z3 import Float64, FPVal, Ints, Not, RNE, Solver, fpAdd, fpEQ, unsat

def check(name, assumptions):
    solver = Solver()
    solver.set(timeout=10000)
    solver.add(*assumptions)
    actual = solver.check()
    if actual != unsat:
        raise AssertionError(f'{name}: expected unsat, got {actual}')
    print(f'Proved: {name}')

iteration, bound = Ints('iteration bound')
check('a uint32-bounded iteration advances without exceeding its bound',
      [bound >= 1, bound <= 2**32 - 1, iteration >= 0, iteration < bound,
       (iteration + 1 <= iteration) | (iteration + 1 > bound)])
check('the next uint32-bounded iteration stays within the exact integer range of binary64',
      [bound >= 1, bound <= 2**32 - 1, iteration >= 0, iteration < bound,
       iteration + 1 > 2**53])
value = FPVal(2**53, Float64())
check('binary64 adding one at 2^53 rounds back to the same value',
      [Not(fpEQ(fpAdd(RNE(), value, FPVal(1, Float64())), value))])
