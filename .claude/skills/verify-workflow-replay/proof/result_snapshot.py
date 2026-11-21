"""Abstract result snapshots over arbitrary values, assuming truthful validation."""
from z3 import And, Bool, Implies, Not, Solver, String, sat, unsat

captured, recorded, returned = String('captured'), String('recorded'), String('returned')
valid, completed = Bool('valid'), Bool('completed')
assumptions = [
    Implies(completed, valid),
    Implies(completed, recorded == captured),
    Implies(completed, returned == captured),
]
claims = [Implies(completed, valid), Implies(completed, returned == recorded)]

def check(name, constraints, claim, wanted):
    solver = Solver()
    solver.add(*constraints, Not(claim))
    actual = solver.check()
    if actual != wanted:
        raise AssertionError(f'{name}: expected {wanted}, got {actual}')
    print(f"{'Proved' if wanted == unsat else 'Expected counterexample'}: {name}")

check('returned result matches record', assumptions, claims[1], unsat)
check(
    'completed ties capture to record and return',
    assumptions,
    Implies(completed, And(recorded == captured, returned == captured)),
    unsat,
)
check('missing result validation', assumptions[1:], claims[0], sat)
check('returning the mutable source', assumptions[:2], claims[1], sat)
