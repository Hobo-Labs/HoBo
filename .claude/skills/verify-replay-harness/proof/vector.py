"""Maximum and selection obligations for abstract replay sequence vectors.

These obligations assume faithful map keys and numeric comparison; they do
not prove TypeScript's use of Map or validate event sequence numbers.
"""
from z3 import And, Bool, If, Implies, Int, Not, Or, Solver, sat, unsat

previous, next_value = Int('previous'), Int('next_value')
own, inherited, selected = Bool('own'), Bool('inherited'), Bool('selected')
maximum = If(previous >= next_value, previous, next_value)

def check(name, assumptions, claim, expected):
    solver = Solver()
    solver.add(*assumptions, Not(claim))
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

check('maximum retains the previous bound', [], maximum >= previous, unsat)
check('maximum includes the next sequence', [], maximum >= next_value, unsat)
check('selection is owned', [selected == own], Implies(selected, own), unsat)
check('overwriting can lose a previous maximum', [previous > next_value], next_value >= previous, sat)
check('inherited selection can bypass an own target', [selected == Or(own, inherited)], Implies(selected, own), sat)
