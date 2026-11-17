#!/usr/bin/env python3
"""Unbounded exact-real obligations for the final admission guards."""
import os
import sys
from z3 import And, Bool, Not, Real, Solver, sat, unsat

fresh, environment, catalog, confirmed = (Bool(n) for n in ('fresh','environment','catalog','confirmed'))
quoted, bound, gate, held, cap, budget = (Real(n) for n in ('quoted','bound','gate','held','cap','budget'))
mutation = os.environ.get('BROKER_ADMISSION_PROOF_MUTATION', '')
base = And(quoted >= 0, bound >= quoted, cap >= 0, budget >= 0, bound <= cap, bound <= budget)
premise = And(base,
    fresh if mutation != 'fresh' else True,
    environment if mutation != 'environment' else True,
    catalog if mutation != 'catalog' else True,
    confirmed if mutation != 'hold' else True,
    gate >= bound if mutation != 'gate' else True,
    held >= bound if mutation != 'amount' else True)
obligations = [
    ('quote remains fresh', fresh), ('environment remains approved', environment),
    ('catalog remains current', catalog), ('new hold confirmed', confirmed),
    ('gate sees liability', gate >= bound), ('hold covers liability', held >= bound),
    ('liability covers quote', bound >= quoted), ('liability fits cap', bound <= cap),
    ('liability fits budget', bound <= budget),
]
witness=Solver(); witness.add(premise)
assert witness.check() == sat, 'vacuous admission premise'
failed=False
for label, conclusion in obligations:
    solver=Solver(); solver.add(premise,Not(conclusion))
    if solver.check() != unsat:
        print(f'FAIL {label}: {solver.model()}'); failed=True
    else:
        print(f'PASS {label}: all modeled exact-real inputs satisfying the guards')
print('SCOPE: assumes honest host evidence, accurate bound and hold confirmation; no implementation refinement, shared storage or provider effects are proven')
sys.exit(1 if failed else 0)
