#!/usr/bin/env python3
"""Symbolic obligations under collision resistance and truthful proof binding."""
import os
import sys
from z3 import And, Bool, Const, DeclareSort, Function, Implies, Int, IntSort, Not, Solver, sat, unsat

Quote = DeclareSort('Quote')
hash_of = Function('hash_of', Quote, IntSort())
selected, approved = Const('selected', Quote), Const('approved', Quote)
digest = Int('proof_digest')
issued, has_digest, id_matches = (Bool(name) for name in ('issued', 'has_digest', 'id_matches'))
mutation = os.environ.get('YARD_POLICY_PROOF_MUTATION', '')
proof_binding = Implies(has_digest, digest == hash_of(approved))
collision_resistance = Implies(hash_of(selected) == hash_of(approved), selected == approved)
requirements = []
if mutation != 'presence': requirements.append(has_digest)
if mutation != 'identifier': requirements.append(id_matches)
if mutation != 'digest': requirements.append(digest == hash_of(selected))
premise = And(Implies(issued, And(*requirements)),
              proof_binding if mutation != 'proof_binding' else True,
              collision_resistance if mutation != 'collision' else True)
obligations = [('present digest', Implies(issued, has_digest)),
               ('matching ID', Implies(issued, id_matches)),
               ('approved content', Implies(issued, selected == approved))]
witness = Solver(); witness.add(premise, issued, has_digest, id_matches, selected == approved)
assert witness.check() == sat, 'no successful authorization witness'
failed = False
for label, obligation in obligations:
    solver = Solver(); solver.add(premise, Not(obligation)); result = solver.check()
    if result == unsat: print(f'PASS {label}')
    else:
        print(f'FAIL {label}: {result} {solver.model() if result == sat else solver.reason_unknown()}')
        failed = True
print('SCOPE: assumes honest proof binding, collision resistance for this pair and correct serialization; does not prove TypeScript refinement or provider costs')
sys.exit(1 if failed else 0)
