"""Abstract input capture and JSON-roundtrip guards over arbitrary values.

The obligations assume truthful equality and a stable local snapshot. They do
not prove the JavaScript serializer, runtime refinement or external effects.
"""
from z3 import And, Bool, Implies, Not, Solver, String, sat, unsat

original, journal, effect = String('original'), String('journal'), String('effect')
valid, ran = Bool('valid'), Bool('ran')
guards = [journal == original, Implies(ran, effect == original), Implies(ran, valid)]
properties = [Implies(ran, effect == journal), Implies(ran, valid)]

def check(name, assumptions, claim, wanted):
    solver = Solver()
    solver.add(*assumptions, Not(claim))
    actual = solver.check()
    if actual != wanted:
        raise AssertionError(f'{name}: expected {wanted}, got {actual}')
    print(f"{'Proved' if wanted == unsat else 'Expected counterexample'}: {name}")

check('captured work matches journal', guards, properties[0], unsat)
check('executed input is reproducible', guards, properties[1], unsat)
check('missing input snapshot', [guards[0], guards[2]], properties[0], sat)
check('missing input validation', [guards[0], guards[1]], properties[1], sat)
