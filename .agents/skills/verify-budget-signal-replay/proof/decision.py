#!/usr/bin/env python3
"""Symbolic proof of the replay decision for arbitrary abstract record attributes."""
import os
import sys
from z3 import And, Bool, Not, Or, Solver, sat, unsat

complete, history_reconstructed, same_key, signal_type, same_scope, same_payload, metadata_ok = (
    Bool(name) for name in ('complete', 'history_reconstructed', 'same_key', 'signal_type', 'same_scope', 'same_payload', 'metadata_ok')
)
mutation = os.environ.get('BUDGET_SIGNAL_PROOF_MUTATION', '')
checks = [signal_type, same_scope, same_payload, metadata_ok]
if mutation in ('type', 'scope', 'payload', 'metadata'):
    checks[{'type': 0, 'scope': 1, 'payload': 2, 'metadata': 3}[mutation]] = True
conflict = And(same_key, Not(And(*checks)))
refused = Or(Not(complete) if mutation != 'incomplete' else False,
             Not(history_reconstructed) if mutation != 'orphan' else False, conflict)
suppressed = And(Not(refused), same_key)
emitted = And(Not(refused), Not(same_key))

obligations = [
    ('suppression requires complete and identical evidence', suppressed,
     And(complete, history_reconstructed, same_key, signal_type, same_scope, same_payload, metadata_ok)),
    ('incomplete financial facts cannot return signals', Not(complete),
     And(Not(suppressed), Not(emitted))),
    ('orphaned history cannot return signals', Not(history_reconstructed),
     And(Not(suppressed), Not(emitted))),
    ('conflicting keys require reconciliation', And(same_key, Not(And(signal_type, same_scope, same_payload, metadata_ok))),
     refused),
    ('unoccupied keys emit when facts are complete', And(complete, history_reconstructed, Not(same_key)), emitted),
    ('identical records suppress on complete replay', And(complete, history_reconstructed, same_key, signal_type, same_scope, same_payload, metadata_ok), suppressed),
]
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
        print(f'PASS {label}: all abstract boolean inputs satisfying the premise')
print('SCOPE: this proves the abstract decision, not its TypeScript refinement, key construction, event authenticity, arithmetic or concurrent append')
sys.exit(1 if failed else 0)
