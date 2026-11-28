#!/usr/bin/env python3
"""Symbolic approved-snapshot and persistent-worker obligations."""
import os
import sys
from z3 import And, Bool, Const, DeclareSort, If, Implies, Not, Solver, sat, unsat

Inputs = DeclareSort('Inputs')
(baseline, source_at_copy, copied, digest, after_approval, before_start,
 worker_inputs, executed) = (
    Const(name, Inputs) for name in (
        'baseline', 'source_at_copy', 'copied', 'digest', 'after_approval',
        'before_start', 'worker_inputs', 'executed'))
(available, approved, prepared, invoked, worker_verified, started, persistent) = (
    Bool(name) for name in (
        'available', 'approved', 'prepared', 'invoked', 'worker_verified',
        'started', 'persistent'))
mutation = os.environ.get('HOBO_LOCAL_WORK_MUTATION', '')
work = If(persistent, worker_inputs, copied)
premise = And(
    Implies(approved, available) if mutation != 'snapshot' else True,
    Implies(approved, source_at_copy == baseline)
        if mutation != 'materialize' else True,
    Implies(approved, copied == source_at_copy) if mutation != 'bind' else True,
    Implies(approved, digest == baseline) if mutation != 'digest' else True,
    Implies(prepared, approved),
    Implies(prepared, after_approval == baseline)
        if mutation != 'approval' else True,
    Implies(invoked, prepared),
    Implies(invoked, before_start == baseline)
        if mutation != 'handoff' else True,
    Implies(And(started, persistent), worker_verified),
    Implies(worker_verified, worker_inputs == baseline)
        if mutation != 'worker' else True,
    Implies(started, invoked),
    Implies(started, executed == work) if mutation != 'execute' else True,
)
obligations = [
    ('an available input snapshot was captured', Implies(started, available)),
    ('the copied source was the approved source',
     Implies(started, source_at_copy == baseline)),
    ('the execution copy binds the copied bytes',
     Implies(started, copied == source_at_copy)),
    ('the placement proof binds the approved input',
     Implies(started, digest == baseline)),
    ('post-approval source observation is current',
     Implies(prepared, after_approval == baseline)),
    ('handoff source observation is current',
     Implies(invoked, before_start == baseline)),
    ('the worker verifies its execution copy',
     Implies(And(started, persistent), worker_inputs == baseline)),
    ('executed work matches the approved input',
     Implies(started, executed == baseline)),
]
witness = Solver()
witness.add(premise, started, available, source_at_copy == baseline,
            copied == baseline, digest == baseline,
            after_approval == baseline, before_start == baseline,
            worker_inputs == baseline, executed == baseline)
assert witness.check() == sat
failed = False
for label, obligation in obligations:
    solver = Solver()
    solver.add(premise, Not(obligation))
    result = solver.check()
    if result == unsat:
        print(f'PASS {label}')
    else:
        print(f'FAIL {label}: {result} '
              f'{solver.model() if result == sat else solver.reason_unknown()}')
        failed = True
print('SCOPE: equality abstracts SHA-256 and exact byte copying; excluded dependencies, '
      'dynamic external reads, same-user snapshot tampering and TypeScript refinement remain trusted')
sys.exit(1 if failed else 0)
