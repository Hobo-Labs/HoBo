"""Abstract snapshot obligations for replay boundaries and event histories.

Assumes capture is detached and describes the values supplied to both folds
and the report. It does not verify JavaScript cloning or callback purity.
"""
from z3 import Bool, Implies, Not, Solver, String, sat, unsat

captured, selected, reported = String('captured'), String('selected'), String('reported')
event, live, replay, read_set = String('event'), String('live'), String('replay'), String('read_set')
owned, included = Bool('owned'), Bool('included')
guards = [selected == captured, reported == captured, live == event, replay == event, read_set == event, Implies(owned, included)]
claims = [selected == reported, live == replay, live == read_set, Implies(owned, included)]

def check(name, assumptions, claim, expected):
    solver = Solver()
    solver.add(*assumptions, Not(claim))
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

for label, claim in zip(('target', 'folds', 'read set', 'own entry'), claims):
    check(f'{label} snapshot', guards, claim, unsat)
for guard, claim in ((1, 0), (3, 1), (4, 2), (5, 3)):
    check(f'missing snapshot guard {guard}', guards[:guard] + guards[guard + 1:], claims[claim], sat)
