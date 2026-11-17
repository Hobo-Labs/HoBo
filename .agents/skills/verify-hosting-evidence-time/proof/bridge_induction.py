#!/usr/bin/env python3
"""Exact-real observation time against a nonnegative integer millisecond clock."""
import os
import sys
from z3 import And, Int, Not, Real, Solver, ToInt, ToReal, sat, unsat
observed, clock = Real('observed_milliseconds'), Int('clock_milliseconds')
mutation = os.environ.get('HOSTING_BRIDGE_PROOF_MUTATION', '')
accepted = And(observed >= 0, clock >= 0,
               ToInt(observed) <= clock if mutation == 'truncate' else observed <= ToReal(clock))
witness = Solver()
witness.add(accepted)
assert witness.check() == sat
solver = Solver()
solver.add(accepted, Not(observed <= ToReal(clock)))
if solver.check() != unsat:
    print(f'FAIL no future observation: {solver.model()}')
    sys.exit(1)
print('PASS no future observation: all exact-real observations and integer clocks satisfying the premises')
print('SCOPE: clock accuracy, parsing, authority authenticity, other bridge checks and TypeScript refinement are not proven')
