#!/usr/bin/env python3
"""Unbounded exact-real abstraction of the two estimate aliases."""
import os
import sys
from z3 import And, Bool, If, Implies, Not, Or, Real, Solver, sat, unsat

a_present, b_present = Bool('camel_present'), Bool('snake_present')
a, b = Real('camel_value'), Real('snake_value')
mutation = os.environ.get('ESTIMATE_PROOF_MUTATION', '')
presence = Or(a_present, b_present) if mutation != 'missing' else True
agreement = Implies(And(a_present, b_present), a == b) if mutation != 'conflict' else True
accepted = And(presence, agreement, Implies(a_present, a >= 0), Implies(b_present, b >= 0))
selected = If(a_present, a, b)
claims = {
    'explicit estimate': Or(a_present, b_present),
    'unambiguous aliases': Implies(And(a_present, b_present), a == b),
    'nonnegative selected estimate': selected >= 0,
}
witness = Solver()
witness.add(accepted)
assert witness.check() == sat
ok = True
for label, claim in claims.items():
    solver = Solver()
    solver.add(accepted, Not(claim))
    if solver.check() != unsat:
        print(f'FAIL {label}: {solver.model()}')
        ok = False
    else:
        print(f'PASS {label}: all accepted exact-real values')
print('SCOPE: JSON/protobuf parsing, finite numeric representations, caller honesty and code refinement are not proven')
if not ok:
    sys.exit(1)
