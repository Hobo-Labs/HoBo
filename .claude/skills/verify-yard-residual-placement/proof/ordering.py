#!/usr/bin/env python3
"""Symbolic ordering obligations for two comparable exact prices."""
import os
import sys
from z3 import And, Bool, If, Implies, Not, Or, Real, Solver, sat, unsat

price_a,price_b=(Real(n) for n in ('price_a','price_b'))
valid_a,valid_b,same_unit,distinct,a_before=(Bool(n) for n in ('valid_a','valid_b','same_unit','distinct','a_before'))
mutation=os.environ.get('YARD_RESIDUAL_PROOF_MUTATION','')
allowed=And(price_a >= 0, price_b >= 0,
            And(valid_a,valid_b) if mutation != 'price' else True,
            same_unit if mutation != 'unit' else True,
            distinct if mutation != 'identity' else True)
a_score=price_a if mutation != 'exact' else 0
b_score=price_b if mutation != 'exact' else 0
tie=a_before if mutation != 'tie' else Not(a_before)
choose_a=If(a_score < b_score,True,If(b_score < a_score,False,tie))
obligations=[
 ('valid prices',And(valid_a,valid_b)), ('comparable units',same_unit), ('unique identities',distinct),
 ('minimum exact price',If(choose_a,price_a <= price_b,price_b <= price_a)),
 ('stable identity tie',Implies(price_a == price_b,choose_a == a_before)),
]
w=Solver(); w.add(allowed); assert w.check() == sat, 'vacuous ordering premise'
failed=False
for label,conclusion in obligations:
 s=Solver(); s.add(allowed,Not(conclusion))
 if s.check() != unsat: print(f'FAIL {label}: {s.model()}'); failed=True
 else: print(f'PASS {label}: all modeled exact-real inputs satisfying the guards')
print('SCOPE: assumes exact price parsing and comparable units; currency, complete quotes, real billing and TypeScript refinement are not proven')
sys.exit(1 if failed else 0)
