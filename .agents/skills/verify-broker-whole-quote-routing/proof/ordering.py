#!/usr/bin/env python3
"""Symbolic minimum-cost and safe-retry obligations for any number of plans."""
import os
import sys
from z3 import And, Array, Bool, ForAll, If, Implies, Int, IntSort, Not, Or, Real, RealSort, Solver, sat, unsat

n, chosen, k, j = (Int(x) for x in ('n', 'chosen', 'k', 'j'))
price = Array('price', IntSort(), RealSort())
bound = Array('bound', IntSort(), RealSort())
available, cap = Real('available'), Real('cap')
evidence, limit, unique, safe_retry = (Bool(x) for x in ('evidence', 'limit', 'unique', 'safe_retry'))
mutation = os.environ.get('BROKER_WHOLE_QUOTE_PROOF_MUTATION', '')
in_range = lambda x: And(x >= 0, x < n)
fits = lambda x: And(bound[x] <= cap, bound[x] <= available)
valid = ForAll([k], Implies(in_range(k), And(price[k] >= 0, bound[k] >= price[k])))
sorted_costs = ForAll([k, j], Implies(And(in_range(k), in_range(j), k < j), price[k] <= price[j]))
earlier_unaffordable = ForAll([k], Implies(And(in_range(k), k < chosen), Not(fits(k))))
premise = And(n > 0, in_range(chosen), cap >= 0, available >= 0, valid,
              sorted_costs if mutation != 'ordering' else True,
              earlier_unaffordable,
              fits(chosen) if mutation != 'budget' else True,
              evidence if mutation != 'evidence' else True,
              limit if mutation != 'limit' else True,
              unique if mutation != 'identity' else True,
              Or(chosen == 0, safe_retry) if mutation != 'retry' else True)
minimum = ForAll([k], Implies(And(in_range(k), fits(k)), price[chosen] <= price[k]))
obligations = [
    ('complete trusted search', evidence), ('bounded search', limit), ('unique resource identities', unique),
    ('selected liability fits budget', fits(chosen)), ('minimum quoted cost among affordable candidates', minimum),
    ('prior denial safe to retry', Implies(chosen > 0, safe_retry)),
]
for label, extra in [('first candidate', chosen == 0), ('fallback', chosen > 0)]:
    witness = Solver(); witness.add(premise, extra)
    assert witness.check() == sat, f'vacuous {label} premise'
failed = False
for label, conclusion in obligations:
    solver = Solver(); solver.add(premise, Not(conclusion))
    result = solver.check()
    if result != unsat:
        print(f'FAIL {label}: {result} {solver.model() if result == sat else solver.reason_unknown()}')
        failed = True
    else:
        print(f'PASS {label}: arbitrary finite count and exact-real amounts under stated premises')
print('SCOPE: sorted complete truthful quotes, fixed limits and honest no-reservation denials are assumptions; no TypeScript refinement or provider correctness is proven')
sys.exit(1 if failed else 0)
