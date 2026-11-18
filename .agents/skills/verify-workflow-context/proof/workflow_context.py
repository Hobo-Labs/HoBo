"""Abstract workflow resume context and definition-capture obligations."""
from z3 import And, Bool, Implies, Not, Solver, sat, unsat

input_ok = Bool('input_ok')
name_ok = Bool('name_ok')
seed_ok = Bool('seed_ok')
checked_input = Bool('checked_input')
checked_name = Bool('checked_name')
checked_seed = Bool('checked_seed')
accepted = And(Implies(checked_input, input_ok), Implies(checked_name, name_ok), Implies(checked_seed, seed_ok))
claim = And(input_ok, name_ok, seed_ok)

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

check('all checks imply valid context', [checked_input, checked_name, checked_seed, accepted, Not(claim)], unsat)
check('missing input check admits invalid input', [Not(checked_input), checked_name, checked_seed, accepted, Not(input_ok)], sat)
check('missing name check admits invalid name', [checked_input, Not(checked_name), checked_seed, accepted, Not(name_ok)], sat)
check('missing seed check admits invalid seed', [checked_input, checked_name, Not(checked_seed), accepted, Not(seed_ok)], sat)

captured = Bool('captured_original')
selected = Bool('selected_original')
check('captured selection preserves the original binding', [captured, selected == captured, Not(selected)], unsat)
check('using a live binding can select a changed value', [captured, Not(selected)], sat)
