"""Prove abstract first-open and monotone-lifecycle obligations."""
from z3 import Bool, If, Ints, Not, Or, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

opened = Bool('opened')
first, stored, incoming, current_rank, incoming_rank = Ints('first stored incoming current_rank incoming_rank')
prior_invariant = Or(Not(opened), stored == first)
next_first = If(opened, first, incoming)
next_impact = If(opened, stored, incoming)
check('opening preserves the first-impact invariant', [prior_invariant, next_impact != next_first], unsat)
check('replacing a duplicate can change the first impact', [opened, prior_invariant, incoming != next_first], sat)
advanced = If(incoming_rank >= current_rank, incoming_rank, current_rank)
check('a ranked lifecycle does not regress', [advanced < current_rank], unsat)
check('accepting an earlier state can regress the lifecycle', [incoming_rank < current_rank], sat)
