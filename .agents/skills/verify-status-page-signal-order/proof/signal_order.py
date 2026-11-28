"""Prove abstract timestamp and label ordering obligations."""
from z3 import If, Ints, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

current, incoming, current_label, incoming_label = Ints('current incoming current_label incoming_label')
newest = incoming >= current
next_time = If(newest, incoming, current)
next_label = If(newest, incoming_label, current_label)
check('the selected measurement timestamp does not regress', [next_time < current], unsat)
check('an older measurement preserves the current label', [incoming < current, next_label != current_label], unsat)
check('a tied measurement selects the incoming label', [incoming == current, next_label != incoming_label], unsat)
check('without the older guard the label can change', [incoming < current, incoming_label != current_label], sat)
