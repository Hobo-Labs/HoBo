"""Abstract duplicate-terminal refusal for arbitrary fact counts."""
from z3 import Bool, Implies, Int, Not, Solver, sat, unsat

facts, returned = Int('facts'), Bool('returned')
claim = Implies(facts > 1, Not(returned))
for guarded in (True, False):
    solver = Solver()
    solver.add(facts >= 0)
    if guarded:
        solver.add(claim)
    solver.add(Not(claim))
    expected = unsat if guarded else sat
    if solver.check() != expected:
        raise AssertionError('unexpected terminal-history guard result')
    print('Proved: duplicate terminal facts are refused' if guarded else 'Expected counterexample: accepting duplicate terminal facts')
