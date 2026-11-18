from z3 import And, Bool, Implies, Not, Or, Solver, sat, unsat

old, new, closed = (Bool(n) for n in ('old', 'new', 'closed'))
old1, new1, closed1 = (Bool(n) for n in ('old1', 'new1', 'closed1'))
inv = And(Implies(old, Not(closed)), Implies(new, closed), Not(And(old, new)))
inv1 = And(Implies(old1, Not(closed1)), Implies(new1, closed1), Not(And(old1, new1)))
initial = And(Not(old), Not(new), Not(closed))
start = And(Not(old), Not(new), Not(closed), old1, Not(new1), Not(closed1))
close = And(old, Not(old1), new1 == new, closed1)
wait = And(old1 == old, new1 == new, closed1 == closed)
restart = And(closed, old1 == old, new1, closed1 == closed)
for name, formula, expected in (
    ('initial state satisfies exclusion', And(initial, Not(inv)), unsat),
    ('guarded transitions preserve exclusion', And(inv, Or(start, close, wait, restart), Not(inv1)), unsat),
    ('an unfenced replacement can overlap the old deployment', And(inv, old, Not(closed), old1 == old, new1, closed1 == closed, Not(inv1)), sat),
):
    solver = Solver()
    solver.add(formula)
    result = solver.check()
    if result != expected:
        raise AssertionError(f'{name}: expected {expected}, got {result}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")
