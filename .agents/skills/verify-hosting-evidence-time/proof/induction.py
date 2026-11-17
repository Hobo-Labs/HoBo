#!/usr/bin/env python3
"""Unbounded exact-real abstraction of financial freshness and history."""
import os
import sys
from z3 import And, Bool, Implies, Not, Or, Real, Solver, sat, unsat

observed, now, expiry, old, new = [Real(x) for x in ('observed', 'now', 'expiry', 'old', 'new')]
valid, changed, evidence, spend = [Bool(x) for x in ('valid', 'changed', 'evidence', 'spend')]
mutation = os.environ.get('HOSTING_TIME_PROOF_MUTATION', '')
fresh = And(valid, observed <= now if mutation != 'future' else True, now < expiry)
history = And(new >= old, Or(new > old, Not(changed), And(spend, evidence) if mutation != 'equality' else True))
claims = [
    ('accepted evidence is valid, not future or expired', fresh, And(valid, observed <= now, now < expiry)),
    ('accepted history does not go backwards', history, new >= old),
    ('same-time changes need spend reconciliation', history, Implies(And(changed, new == old), And(spend, evidence))),
]
ok = True
for label, premise, claim in claims:
    witness = Solver()
    witness.add(premise)
    if witness.check() != sat:
        raise RuntimeError(f'{label}: no premise witness')
    solver = Solver()
    solver.add(premise, Not(claim))
    if solver.check() != unsat:
        print(f'FAIL {label}: {solver.model()}')
        ok = False
    else:
        print(f'PASS {label}: all exact-real values satisfying the premises')
print('SCOPE: calendar parsing, offset conversion, storage, provider evidence and TypeScript refinement are not proven')
if not ok:
    sys.exit(1)
