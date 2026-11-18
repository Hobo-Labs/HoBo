"""Replay ordering obligations over an abstract two-key total order.

These obligations do not prove JavaScript comparison, hashing, or refinement.
"""
from z3 import And, Bool, If, Implies, Int, Not, Or, Solver, sat, unsat

x = Int('rank_x')
y = Int('rank_y')
left_reversed = Bool('left_reversed')
right_reversed = Bool('right_reversed')

def first(reversed_input, rank_x, rank_y):
    return If(reversed_input,
              If(rank_y <= rank_x, 1, 0),
              If(rank_x <= rank_y, 0, 1))

def check(name, assumptions, claim, expected):
    solver = Solver()
    solver.add(*assumptions, Not(claim))
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

same = first(left_reversed, x, y) == first(right_reversed, x, y)
check('distinct keys under one total order produce one ordering', [x != y], same, unsat)
check('tied distinct keys can depend on insertion order', [], same, sat)

marked = Bool('marked')
version = Int('version')
interpreted = If(marked, version, 1)
valid = Or(version == 1, version == 2)
check('preserved marker identifies the encoding', [valid, marked], interpreted == version, unsat)
check('dropping a version-two marker loses its interpretation', [version == 2], interpreted == version, sat)
check('unmarked legacy evidence is interpreted as version one', [Not(marked)], interpreted == 1, unsat)
check('using version two as the legacy default is wrong', [Not(marked)], If(marked, version, 2) == 1, sat)

accepted = And(valid, version != 3)
check('unknown version is refused', [version == 3], Not(accepted), unsat)
check('accepting every version admits an unknown version', [version == 3], Not(version >= 1), sat)
