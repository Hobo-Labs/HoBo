"""Abstract obligations for an exclusive, identity-bound load."""
from z3 import And, Bool, If, Not, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

loaded, loading, guard_loaded, guard_loading = [Bool(n) for n in ('loaded', 'loading', 'guard_loaded', 'guard_loading')]
accepted = And(Not(And(guard_loaded, loaded)), Not(And(guard_loading, loading)))
check('both guards refuse any occupied identity', [guard_loaded, guard_loading, accepted, loaded], unsat)
check('both guards refuse a concurrent construction', [guard_loaded, guard_loading, accepted, loading], unsat)
check('without the loading guard a reentrant attempt is admitted', [guard_loaded, Not(guard_loading), loading, Not(loaded), accepted], sat)

matching, check_identity, accepted_instance = [Bool(n) for n in ('matching', 'check_identity', 'accepted_instance')]
check('identity check prevents accepting a mismatch', [check_identity, accepted_instance == If(check_identity, matching, True), accepted_instance, Not(matching)], unsat)
check('without identity checking a mismatch is admitted', [Not(check_identity), accepted_instance == If(check_identity, matching, True), accepted_instance, Not(matching)], sat)
