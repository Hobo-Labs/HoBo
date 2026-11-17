#!/usr/bin/env python3
"""Exact-real obligations for trusted quote and explicit legacy authorization."""
import os
import sys
from z3 import And, Bool, Not, Or, Real, Solver, sat, unsat

valid, attested, mutated, trusted = (Bool(name) for name in ('valid', 'attested', 'mutated', 'trusted'))
quoted, bound, cap, budget, later_cap = (Real(name) for name in ('quoted', 'bound', 'cap', 'budget', 'later_cap'))
mutation = os.environ.get('QUOTE_PROVENANCE_PROOF_MUTATION', '')
base = And(quoted >= 0, bound >= 0, cap >= 0, budget >= 0, later_cap >= 0)
quote_allowed = And(base, valid,
                    attested if mutation != 'attestation' else True,
                    Not(mutated) if mutation != 'mutation' else True,
                    bound >= quoted if mutation != 'bound' else True,
                    bound <= (later_cap if mutation == 'policy' else cap),
                    bound <= budget if mutation != 'budget' else True)
legacy_allowed = And(base, valid, trusted if mutation != 'legacy' else True, quoted <= cap, quoted <= budget)
obligations = [
    ('accepted quote is attested', quote_allowed, attested),
    ('accepted quote did not change', quote_allowed, Not(mutated)),
    ('liability covers quoted cost', quote_allowed, bound >= quoted),
    ('liability fits the original cap', quote_allowed, bound <= cap),
    ('liability fits the original budget', quote_allowed, bound <= budget),
    ('legacy estimate requires explicit trust', legacy_allowed, trusted),
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
        print(f'PASS {label}: all modeled exact-real inputs satisfying the premises')
print('SCOPE: host attestation truth, signatures, quote-to-work binding, number conversion, holds and TypeScript refinement are not proven')
sys.exit(1 if failed else 0)
