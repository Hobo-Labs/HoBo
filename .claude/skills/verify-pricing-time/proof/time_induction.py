"""Unbounded interval-coverage obligation over abstract exact instants."""
import os
from z3 import And, Ints, Not, Or, Solver, sat, unsat

start, end, at, horizon, inner_start, inner_end = Ints('start end at horizon inner_start inner_end')
mutated = os.environ.get('PRICING_TIME_PROOF_MUTATION') == 'omit-end'
guard = start <= at if mutated else And(start <= at, end >= horizon)
base = [guard, at <= inner_start, inner_start <= inner_end, inner_end <= horizon]
probe = Solver(); probe.add(*base)
if probe.check() != sat:
    raise SystemExit('coverage premises have no witness')
proof = Solver(); proof.add(*base, Or(start > inner_start, end < inner_end))
if proof.check() != unsat:
    print('FAIL: an accepted interval may not cover a subinterval:', proof.model())
    raise SystemExit(1)
print('PASS: an exact covering interval covers every contained subinterval')
