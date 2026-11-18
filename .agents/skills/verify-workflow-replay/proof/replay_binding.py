"""Abstract replay binding over arbitrary strings and captured callbacks.

The obligations assume truthful journal observations, equality and snapshot
operations. They do not prove JavaScript refinement or callback purity.
"""
from z3 import Bool, Implies, Not, Solver, String, sat, unsat

captured, recorded, used = String('captured'), String('recorded'), String('used')
name, recorded_name = String('name'), String('recorded_name')
seed, recorded_seed = String('seed'), String('recorded_seed')
code, captured_code = String('code'), String('captured_code')
executed = Bool('executed')
guards = [
    Implies(executed, captured == recorded),
    Implies(executed, name == recorded_name),
    Implies(executed, seed == recorded_seed),
    Implies(executed, used == captured),
    Implies(executed, code == captured_code),
]
claims = [
    Implies(executed, used == recorded),
    Implies(executed, name == recorded_name),
    Implies(executed, seed == recorded_seed),
    Implies(executed, code == captured_code),
]

def check(name, assumptions, claim, expected):
    solver = Solver()
    solver.add(*assumptions, Not(claim))
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

for label, claim in zip(('input', 'name', 'seed', 'callbacks'), claims):
    check(f'replay {label} binding', guards, claim, unsat)
for index, claim_index in enumerate((0, 1, 2, 0, 3)):
    check(f'missing replay guard {index}', guards[:index] + guards[index + 1:], claims[claim_index], sat)
