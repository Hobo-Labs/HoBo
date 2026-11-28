#!/usr/bin/env python3
"""Prove single-process delivery count and guard implications by induction."""
import os
import sys
from z3 import And, Bool, Implies, Int, Not, Or, Solver, sat, unsat

phase, after, count, next_count = (Int(n) for n in ('phase','after','count','next_count'))
authentic, fresh, context = (Bool(n) for n in ('authentic','fresh','context'))
mutation=os.environ.get('BROKER_DELIVERY_PROOF_MUTATION','')
READY, VALIDATING, SUBMITTING, COMPLETED, UNCERTAIN = range(5)
def inv(p,n):
    return And(p >= READY, p <= UNCERTAIN, n >= 0, n <= 1, Implies(n == 1, Or(p == SUBMITTING,p == COMPLETED,p == UNCERTAIN)))
transition=Or(
    And(phase == READY, after == VALIDATING, next_count == count),
    And(phase == VALIDATING, after == READY, next_count == count),
    And(phase == VALIDATING, after == SUBMITTING, next_count == count + 1),
    And(phase == SUBMITTING, Or(after == COMPLETED, after == UNCERTAIN), next_count == count),
    And(phase == after, next_count == count),
    And(mutation == 'retry', Or(phase == COMPLETED, phase == UNCERTAIN), after == READY, next_count == count),
)
guard=And(authentic if mutation != 'origin' else True,
          fresh if mutation != 'fresh' else True,
          context if mutation != 'context' else True)
obligations=[
    ('initial state', And(phase == READY,count == 0), inv(phase,count)),
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
