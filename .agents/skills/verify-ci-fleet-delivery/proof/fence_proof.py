"""Unbounded arithmetic obligations for an abstract monotonic delivery fence."""
import os
from z3 import And, If, Implies, Ints, Not, Solver, sat, unsat

previous, stale = Ints('previous stale')
maximum = 0xffffffff
assumptions = [previous >= 0, previous <= maximum, stale > 0, stale <= previous]
mutation = os.getenv('FLEET_DELIVERY_PROOF_MUTATION')
if mutation not in {'omit-limit-guard', 'wrap'}:
    assumptions.append(previous < maximum)
new = If(previous == maximum, 1, previous + 1) if mutation == 'wrap' else previous + 1
obligation = And(new > previous, new <= maximum, Implies(stale > 0, stale != new))
solver = Solver()
solver.add(*assumptions, Not(obligation))
result = solver.check()
if result != unsat:
    print(f'FAIL: monotonic delivery fence obligation ({result})')
    if result == sat:
        print(solver.model())
    raise SystemExit(1)
print('PASS: each bounded monotonic fence is distinct from every earlier fence')
