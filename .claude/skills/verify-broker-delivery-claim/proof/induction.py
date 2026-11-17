#!/usr/bin/env python3
"""Prove single-process delivery count and guard implications by induction."""
import os
import sys
from z3 import And, Bool, Implies, Int, Not, Or, Solver, sat, unsat

phase, after, count, next_count = (Int(n) for n in ('phase','after','count','next_count'))
authentic, fresh, context = (Bool(n) for n in ('authentic','fresh','context'))
mutation=os.environ.get('BROKER_DELIVERY_PROOF_MUTATION','')
# 0 ready, 1 validating, 2 submitting, 3 completed, 4 uncertain.
def inv(p,n):
    return And(p >= 0, p <= 4, n >= 0, n <= 1, Implies(n == 1, Or(p == 2,p == 3,p == 4)))
transition=Or(
    And(phase == 0, after == 1, next_count == count),
    And(phase == 1, after == 0, next_count == count),
    And(phase == 1, after == 2, next_count == count + 1),
    And(phase == 2, Or(after == 3, after == 4), next_count == count),
    And(phase == after, next_count == count),
    And(mutation == 'retry', Or(phase == 3, phase == 4), after == 0, next_count == count),
)
guard=And(authentic if mutation != 'origin' else True,
          fresh if mutation != 'fresh' else True,
          context if mutation != 'context' else True)
obligations=[
    ('initial state', And(phase == 0,count == 0), inv(phase,count)),
    ('count and claim preserved', And(inv(phase,count),transition), inv(after,next_count)),
    ('dispatch origin', guard, authentic),
    ('dispatch freshness', guard, fresh),
    ('dispatch context', guard, context),
]
failed=False
for label,premise,conclusion in obligations:
    witness=Solver(); witness.add(premise)
    assert witness.check() == sat, f'vacuous obligation: {label}'
    solver=Solver(); solver.add(premise,Not(conclusion))
    if solver.check() != unsat:
        print(f'FAIL {label}: {solver.model()}'); failed=True
    else: print(f'PASS {label}: all modeled inputs satisfying the premises')
print('SCOPE: one process, truthful quote and origin checks, no durable state, receiver, caller identity, clock or TypeScript refinement proof')
sys.exit(1 if failed else 0)
