#!/usr/bin/env python3
"""Exact-real freshness, coverage and whole-minute billing obligations."""
import os
import sys
from z3 import And, Bool, If, Int, Not, Or, Real, RealVal, Solver, ToInt, ToReal, sat, unsat

observed, previous, now, start, finish, expiry = (Real(name) for name in ('observed', 'previous', 'now', 'start', 'finish', 'expiry'))
changed, valid = Bool('changed'), Bool('valid')
duration = Int('duration_ms')
mutation = os.environ.get('CI_TIME_PROOF_MUTATION', '')
allowed = And(valid, observed <= now if mutation != 'future' else True,
              observed >= previous if mutation != 'backward' else True,
              Or(observed != previous, Not(changed)) if mutation != 'same' else True)
covered = expiry >= start + ToReal(duration) if mutation != 'coverage' else expiry >= ToReal(ToInt(start)) + ToReal(duration)
start_ms, finish_ms = ToInt(start), ToInt(finish)
approx = (finish_ms - start_ms + 59_999) / 60_000
billed = If(finish > start + ToReal(approx * 60_000), approx + 1, approx) if mutation != 'duration' else approx
base = And(start >= 0, finish >= start, duration >= 0)
obligations = [
    ('accepted evidence has a valid timestamp', allowed, valid),
    ('accepted evidence is not future', allowed, observed <= now),
    ('accepted evidence does not move backwards', allowed, observed >= previous),
    ('changed evidence needs a newer instant', And(allowed, changed), observed > previous),
    ('accepted evidence covers the full duration', And(start >= 0, duration >= 0, covered), expiry >= start + ToReal(duration)),
    ('whole-minute billing covers the complete duration', base, ToReal(billed * 60_000) >= finish - start),
    ('whole-minute billing is minimal', And(base, billed > 0), ToReal((billed - 1) * 60_000) < finish - start),
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
print('SCOPE: timestamp parsing and addition implementation, source authenticity, clock accuracy, external effects and TypeScript refinement are not proven')
sys.exit(1 if failed else 0)
