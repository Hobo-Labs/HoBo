"""Arithmetic obligation for work admitted after an arbitrarily long claim."""
import os
from z3 import And, Ints, Not, Solver, sat, unsat

start, delay, duration, end = Ints('start delay duration end')
returned = start + delay
assumptions = [start >= 0, delay >= 0, duration > 0, start + duration <= end, returned < end]
if os.getenv('CI_CLAIM_WINDOW_MUTATION') != 'omit-return-check':
    assumptions.append(returned + duration <= end)
feasible = Solver()
feasible.add(*assumptions)
if feasible.check() != sat:
    raise RuntimeError("window assumptions are inconsistent or unknown")
solver = Solver()
solver.add(*assumptions, Not(returned + duration <= end))
result = solver.check()
if result != unsat:
    print(f'FAIL: returned claim can outlast its funded window ({result})')
    if result == sat:
        print(solver.model())
    raise SystemExit(1)
print('PASS: returned work stays within the funded window under the stated check')
