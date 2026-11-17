#!/usr/bin/env python3
"""Guard obligations for local fallback and changing budget requirements."""
import os
import sys
from z3 import And, Bool, Implies, Not, Solver, sat, unsat

initial, at_fallback, at_start, at_preview = (Bool(n) for n in ('initial', 'at_fallback', 'at_start', 'at_preview'))
remote, fallback, started, previewed = (Bool(n) for n in ('remote', 'fallback', 'started', 'previewed'))
mutation = os.environ.get('HOBO_BUDGET_FALLBACK_MUTATION', '')
premise = And(
    Implies(initial, at_fallback), Implies(at_fallback, at_start), Implies(at_fallback, at_preview),
    Implies(remote, Not(initial)) if mutation != 'early' else True,
    Implies(fallback, Not(at_fallback)) if mutation != 'fallback' else True,
    Implies(started, fallback), Implies(previewed, fallback),
    Implies(started, Not(at_start)) if mutation != 'start' else True,
    Implies(previewed, Not(at_preview)) if mutation != 'preview' else True,
)
obligations = [('remote requires an unbudgeted request', Implies(remote, Not(initial))),
               ('budgeted fallback is refused', Implies(fallback, Not(at_fallback))),
               ('local start has no required budget', Implies(started, Not(at_start))),
               ('local preview has no required budget', Implies(previewed, Not(at_preview)))]
witness=Solver(); witness.add(premise, fallback, started, Not(initial), Not(at_fallback), Not(at_start)); assert witness.check()==sat
failed=False
for label, obligation in obligations:
 solver=Solver();solver.add(premise,Not(obligation));result=solver.check()
 if result==unsat:print(f'PASS {label}')
 else:
  print(f'FAIL {label}: {result} {solver.model() if result==sat else solver.reason_unknown()}');failed=True
print('SCOPE: observes monotonic budget requirements at discrete checks; does not verify the TypeScript or a remote Yard')
sys.exit(1 if failed else 0)
