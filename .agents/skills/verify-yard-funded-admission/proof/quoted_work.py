#!/usr/bin/env python3
"""Unbounded work-binding implications for abstract quoted work values."""
import os
import sys
from z3 import And, Bool, Const, DeclareSort, Function, Implies, IntSort, Not, Solver, sat, unsat

Work = DeclareSort('Work')
hash_of = Function('work_hash', Work, IntSort())
quoted, selected, final = (Const(name, Work) for name in ('quoted', 'selected', 'final'))
held, executed, issued, claim_current, effect_current = (Bool(name) for name in ('held', 'executed', 'issued', 'claim_current', 'effect_current'))
mutation = os.environ.get('YARD_QUOTED_WORK_MUTATION', '')
pre_collision = Implies(hash_of(quoted) == hash_of(selected), quoted == selected)
post_collision = Implies(hash_of(quoted) == hash_of(final), quoted == final)
premise = And(
    Implies(held, hash_of(quoted) == hash_of(selected)) if mutation != 'pre_work' else True,
    Implies(executed, held) if mutation != 'hold' else True,
    Implies(executed, claim_current) if mutation != 'claim_plan' else True,
    Implies(executed, effect_current) if mutation != 'effect_plan' else True,
    Implies(issued, executed) if mutation != 'issued_effect' else True,
    Implies(issued, hash_of(quoted) == hash_of(final)) if mutation != 'final_work' else True,
    pre_collision if mutation != 'pre_collision' else True,
    post_collision if mutation != 'post_collision' else True,
)
obligations = [
    ('quoted work held', Implies(held, quoted == selected)),
    ('provider work funded', Implies(executed, held)),
    ('plan current at claim', Implies(executed, claim_current)),
    ('plan current at effect', Implies(executed, effect_current)),
    ('receipt follows provider effect', Implies(issued, executed)),
    ('receipt work quoted', Implies(issued, quoted == final)),
]
witness = Solver(); witness.add(premise, held, executed, issued, claim_current, effect_current, quoted == selected, selected == final)
assert witness.check() == sat, 'no successful funding witness'
failed = False
for label, obligation in obligations:
    solver = Solver(); solver.add(premise, Not(obligation)); result = solver.check()
    if result == unsat: print(f'PASS {label}')
    else:
        print(f'FAIL {label}: {result} {solver.model() if result == sat else solver.reason_unknown()}')
        failed = True
print('SCOPE: assumes truthful quote evidence, correct work serialization, pairwise collision resistance and the listed guards; does not prove TypeScript refinement or provider behavior')
sys.exit(1 if failed else 0)
