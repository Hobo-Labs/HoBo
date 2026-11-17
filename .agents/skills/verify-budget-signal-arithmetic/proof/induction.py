#!/usr/bin/env python3
"""Inductive threshold and wire obligations over arbitrary exact-real inputs."""
import os
import sys
from z3 import And, Bool, If, Not, Or, Real, RealVal, Solver, sat, unsat

spent, credit, amount, limit = (Real(name) for name in ('spent', 'credit', 'amount', 'limit'))
wire_crossed, underflow = Bool('wire_crossed'), Bool('underflow')
mutation = os.environ.get('BUDGET_ARITHMETIC_PROOF_MUTATION', '')
before = spent - credit >= limit
premises = And(spent >= 0, credit >= 0, amount >= 0, limit > 0)
obligations = []
for label, net in [('usage', spent + amount - credit), ('credit', spent - credit - amount)]:
    exact = net >= limit
    next_crossed = net + RealVal('0.1') >= limit if mutation == 'round' else exact
    emits_cross = And(Not(before), next_crossed)
    emits_recovery = And(before, Not(next_crossed))
    accepted = True if mutation == 'wire' else And(Not(underflow), wire_crossed == next_crossed)
    obligations.extend([
        (f'{label} crossing equals the exact comparison', premises, next_crossed == exact),
        (f'{label} accepted wire preserves the decision', And(premises, accepted), And(Not(underflow), wire_crossed == exact)),
    ])
    if label == 'usage':
        obligations.append(('usage crossing notification is justified', And(premises, emits_cross), exact))
        obligations.append(('usage cannot produce a recovery', premises, Not(emits_recovery)))
    else:
        obligations.append(('credit recovery notification is justified', And(premises, emits_recovery), Not(exact)))
        obligations.append(('credit cannot produce a crossing', premises, Not(emits_cross)))

failed = False
for label, premise, conclusion in obligations:
    witness = Solver()
    witness.add(premise)
    assert witness.check() == sat, f'vacuous premise: {label}'
    solver = Solver()
    solver.add(premise, Not(conclusion))
    if solver.check() != unsat:
        print(f'FAIL {label}: {solver.model()}')
        failed = True
    else:
        print(f'PASS {label}: all exact-real values satisfying the premises')
print('SCOPE: decimal parsing, numeric conversion, event authenticity, concurrent journal writes and TypeScript refinement are not proven')
sys.exit(1 if failed else 0)
