"""Prove integer-age implications; this does not verify TypeScript refinement."""
from z3 import And, Ints, Not, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

now, signal, budget = Ints('now signal budget')
age = now - signal
fresh = And(age >= 0, age <= budget)
check('a fresh signal is not in the future', [fresh, signal > now], unsat)
check('a fresh signal is not beyond its budget', [fresh, age > budget], unsat)
check('omitting the lower bound admits a future signal', [age <= budget, signal > now, budget >= 0], sat)
check('omitting the upper bound admits an expired signal', [age >= 0, age > budget, budget >= 0], sat)
check('the signal is fresh at age zero with a nonnegative budget', [budget >= 0, age == 0, Not(fresh)], unsat)
check('the signal is fresh at its budget boundary', [budget >= 0, age == budget, Not(fresh)], unsat)
