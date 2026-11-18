"""Cleanup implications for two temporary process-global overrides.

Assumes attempts are made as stated and a restorable descriptor is restored
by a successful attempt. This is an abstraction, not a TypeScript proof.
"""
from z3 import And, Bool, Implies, Not, Solver, sat, unsat

finished = Bool('finished')
installed = [Bool('clock_installed'), Bool('random_installed')]
restorable = [Bool('clock_restorable'), Bool('random_restorable')]
attempted = [Bool('clock_attempted'), Bool('random_attempted')]
restored = [Bool('clock_restored'), Bool('random_restored')]
guards = [
    Implies(And(finished, installed[0]), attempted[0]),
    Implies(And(attempted[0], restorable[0]), restored[0]),
    Implies(Not(installed[0]), restored[0]),
    Implies(And(finished, installed[1]), attempted[1]),
    Implies(And(attempted[1], restorable[1]), restored[1]),
    Implies(Not(installed[1]), restored[1]),
]
claims = [Implies(And(finished, restorable[i]), restored[i]) for i in range(2)]

def check(name, assumptions, claim, expected):
    solver = Solver()
    solver.add(*assumptions, Not(claim))
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

for index, name in enumerate(('clock', 'random')):
    check(f'{name} cleanup', guards, claims[index], unsat)
for guard, claim in ((0, 0), (1, 0), (3, 1), (4, 1)):
    check(f'missing cleanup guard {guard}', guards[:guard] + guards[guard + 1:], claims[claim], sat)
