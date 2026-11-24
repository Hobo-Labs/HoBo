"""Abstract accounting for one atomic uncertain-runner release."""
import os
from z3 import And, Bool, If, Implies, Ints, Not, Or, Solver, sat, unsat

approved, reserved, available, cost = Ints('approved reserved available cost')
confirmed, claimed, settled, already_released = (Bool(x) for x in ('confirmed', 'claimed', 'settled', 'already_released'))
assumptions = And(approved >= 0, cost > 0, reserved >= cost, available >= 0, approved == reserved + available)
conditions = [Not(already_released), Or(Not(claimed), settled)]
if os.getenv('UNCERTAIN_PROOF_MUTATION') != 'omit-confirmation':
    conditions.append(confirmed)
release = And(*conditions)
new_reserved = If(release, reserved - cost, reserved)
new_available = If(release, available + cost, available)
new_released = Or(already_released, release)
second_release = And(Not(new_released), confirmed, Or(Not(claimed), settled))
obligation = And(new_reserved >= 0, new_reserved + new_available == approved,
                 Implies(release, confirmed), Implies(And(release, claimed), settled),
                 Implies(release, Not(second_release)))
solver = Solver()
solver.add(assumptions, Not(obligation))
result = solver.check()
if result != unsat:
    print(f'FAIL: uncertain release obligation ({result})')
    if result == sat:
        print(solver.model())
    raise SystemExit(1)
print('PASS: atomic confirmed release preserves unbounded accounting and cannot release twice')
