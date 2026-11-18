"""Prove abstract terminal and pending-state obligations, not TypeScript refinement."""
from z3 import Bool, Const, EnumSort, If, Not, Or, Solver, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

State, (scheduled, progress, completed, canceled) = EnumSort('State', ['scheduled', 'progress', 'completed', 'canceled'])
current, incoming = Const('current', State), Const('incoming', State)
terminal = Or(current == completed, current == canceled)
def rank(state):
    return If(state == scheduled, 0, If(state == progress, 1, 2))
ranked = If(rank(incoming) >= rank(current), incoming, current)
after = If(terminal, current, ranked)
check('a terminal outcome cannot change', [terminal, after != current], unsat)
check('rank alone can change a terminal outcome', [terminal, ranked != current], sat)
remembered, retained = Bool('remembered'), Bool('retained')
visible = If(remembered, retained, False)
check('a recorded pending fact is available at scheduling', [remembered, retained, Not(visible)], unsat)
check('discarding a pending fact loses it at scheduling', [Not(remembered), retained, Not(visible)], sat)
