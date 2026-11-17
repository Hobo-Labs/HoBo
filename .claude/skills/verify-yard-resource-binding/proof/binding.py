#!/usr/bin/env python3
"""Association obligations for two arbitrary resource and definition IDs."""
import os
import sys
from z3 import And, Bool, If, Implies, Int, Not, Solver, sat, unsat
r1, r2, d1, d2, initial, changed = (Int(x) for x in ('r1','r2','d1','d2','initial','changed'))
mutated = Bool('mutated')
mutation = os.environ.get('YARD_BINDING_PROOF_MUTATION','')
unique = r1 != r2 if mutation != 'identity' else True
lookup = lambda key: If(key == r1, d2 if mutation == 'association' else d1, If(key == r2, d2, 0))
bound = initial if mutation != 'snapshot' else If(mutated, changed, initial)
premise = And(unique, initial != changed)
obligations = [('first resource association', lookup(r1) == d1),
               ('second resource association', lookup(r2) == d2),
               ('accepted resource snapshot', bound == initial)]
witness = Solver(); witness.add(premise, mutated); assert witness.check() == sat, 'vacuous mutated-input premise'
failed = False
for label, conclusion in obligations:
 solver=Solver(); solver.add(premise, Not(conclusion)); result=solver.check()
 if result != unsat:
  print(f'FAIL {label}: {result} {solver.model() if result == sat else solver.reason_unknown()}'); failed=True
 else: print(f'PASS {label}: arbitrary identities under stated premises')
print('SCOPE: models two IDs and a private snapshot, assumes exact identity and does not prove TypeScript refinement, transport or execution')
sys.exit(1 if failed else 0)
