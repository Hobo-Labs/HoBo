"""Abstract duplicate-terminal refusal for arbitrary fact counts."""
from z3 import Bool, Implies, Int, Not, Solver, sat

facts, returned = Int('facts'), Bool('returned')
claim = Implies(facts > 1, Not(returned))

solver = Solver()
solver.add(facts >= 0, facts > 1, returned)
if solver.check() != sat:
    raise AssertionError('expected counterexample when duplicate terminal facts return')
print('Expected counterexample: accepting duplicate terminal facts')

solver = Solver()
solver.add(facts >= 0, Not(claim))
if solver.check() != sat:
    raise AssertionError('duplicate terminal refusal should be refutable without the guard')
print('Confirmed: duplicate terminal refusal is not a tautology without enforcement')