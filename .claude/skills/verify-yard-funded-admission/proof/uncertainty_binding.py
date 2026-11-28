"""Uncertainty binding implications over abstract strings and a claimed flag.

The solver assumes the observations and local snapshot are meaningful. It does
not prove adapter honesty, TypeScript refinement or distributed atomicity.
"""
from z3 import And, Bool, Implies, Not, Or, Solver, String, sat, unsat

bound, returned, stored = (String(name) for name in ('bound', 'returned', 'stored'))
expected, actual_return, actual_store = (String(name) for name in ('expected', 'actual_return', 'actual_store'))
claimed, accepted = Bool('claimed'), Bool('accepted')
guards = [returned == bound, stored == bound,
          And(Or(actual_return == '', actual_return == expected),
              Or(actual_store == '', actual_store == expected)),
          actual_return == actual_store,
          Implies(claimed, And(actual_return == expected, actual_store == expected))]
names = ['returned quote', 'stored quote', 'execution domain', 'execution agreement', 'known claim']
property = And(*guards)


def check(omitted=None):
    solver = Solver()
    solver.add(expected != '')
    solver.add(accepted)
    solver.add(Implies(accepted, And(*(guard for i, guard in enumerate(guards) if i != omitted))))
    solver.add(Not(property))
    result = solver.check()
    wanted = unsat if omitted is None else sat
    if result != wanted:
        raise AssertionError(f'expected {wanted}, got {result} for {omitted}')
    print('Proved: captured uncertainty binding' if omitted is None else f'Expected counterexample: missing {names[omitted]}')


check()
for i in range(len(guards)):
    check(i)
