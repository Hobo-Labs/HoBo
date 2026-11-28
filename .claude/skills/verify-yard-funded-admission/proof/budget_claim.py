#!/usr/bin/env python3
"""Symbolic binding implications for Yard generation budget claim evidence."""
import os
import sys
from z3 import And, Bool, Implies, Int, Not, Solver, String, sat, unsat

mutation = os.environ.get('YARD_BUDGET_CLAIM_PROOF_MUTATION', '')
fields = ('reservation', 'request', 'quote', 'quote_digest', 'identity', 'execution', 'amount')
stages = ('returned', 'stored', 'boundary')
expected = {field: Int('expected_amount') if field == 'amount' else String('expected_' + field) for field in fields}
observed = {
    stage: {field: Int(stage + '_amount') if field == 'amount' else String(stage + '_' + field) for field in fields}
    for stage in stages
}
called, unknown, rejected, reported = (Bool(name) for name in ('called', 'unknown', 'rejected', 'reported'))
guards = [observed[stage][field] == expected[field]
          for stage in stages for field in fields
          if mutation != stage and mutation != field]
premise = And(
    expected['amount'] >= 0,
    Implies(called, And(*guards)),
    Implies(unknown, Not(called)) if mutation != 'unknown_stop' else True,
    Implies(unknown, And(rejected, reported)) if mutation != 'unknown_report' else True,
)
obligations = [
    (stage + ' ' + field, Implies(called, observed[stage][field] == expected[field]))
    for stage in stages for field in fields
] + [
    ('unknown claim does not call the provider', Implies(unknown, Not(called))),
    ('unknown claim is rejected and reported', Implies(unknown, And(rejected, reported))),
]
witness = Solver(); witness.add(premise, called, Not(unknown)); assert witness.check() == sat
witness = Solver(); witness.add(premise, unknown); assert witness.check() == sat
failed = False
for label, conclusion in obligations:
    solver = Solver(); solver.add(premise, Not(conclusion)); result = solver.check()
    if result == unsat: print('PASS', label)
    else:
        print(f'FAIL {label}: {result} {solver.model() if result == sat else solver.reason_unknown()}')
        failed = True
print('SCOPE: unbounded abstract identities and integer amounts; assumes truthful, stable observations and that the listed guards gate provider dispatch; does not prove TypeScript refinement or external provider behavior')
sys.exit(1 if failed else 0)
