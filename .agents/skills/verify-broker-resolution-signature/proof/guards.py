#!/usr/bin/env python3
"""Symbolic guard obligations for signature verification and key output."""
import os
import sys
from z3 import And, Bool, Implies, Not, Or, Solver, sat, unsat

sign, enrolled, same, valid, digest, signing_match, public_only = (Bool(n) for n in ('sign','enrolled','same','valid','digest','signing_match','public_only'))
mutation=os.environ.get('BROKER_SIGNATURE_PROOF_MUTATION','')
verify=And(enrolled if mutation != 'trust' else True,
           same if mutation != 'key' else True,
           valid if mutation != 'signature' else True,
           digest if mutation != 'digest' else True,
           public_only if mutation != 'public' else True)
signing=And(signing_match if mutation != 'signing' else True,
            public_only if mutation != 'public' else True)
premise=Or(And(sign,signing),And(Not(sign),verify))
obligations=[
    ('verification uses enrolled matching key', Implies(Not(sign), And(enrolled,same))),
    ('verification checks signature', Implies(Not(sign),valid)),
    ('verification checks digest', Implies(Not(sign),digest)),
    ('signing keys match', Implies(sign,signing_match)),
    ('advertised keys contain public material only', public_only),
]
failed=False
w=Solver(); w.add(premise); assert w.check() == sat, 'vacuous acceptance premise'
for label,conclusion in obligations:
    solver=Solver(); solver.add(premise,Not(conclusion))
    if solver.check() != unsat: print(f'FAIL {label}: {solver.model()}'); failed=True
    else: print(f'PASS {label}: all modeled inputs satisfying the guards')
print('SCOPE: assumes cryptographic primitives, key enrollment and Boolean abstractions; no cryptographic or TypeScript refinement proof')
sys.exit(1 if failed else 0)
