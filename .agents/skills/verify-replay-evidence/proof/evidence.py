"""Abstract replay evidence detachment and immutability obligations."""
from z3 import Bool, If, Int, Not, Solver, sat, unsat

original = Int('original')
replacement = Int('replacement')
detached = Bool('detached')
vector_changed = Bool('vector_changed')
entry_changed = Bool('entry_changed')
marker_changed = Bool('marker_changed')
input_after = replacement
reported = If(vector_changed, replacement,
              If(entry_changed, replacement,
                 If(detached, original, input_after)))

def check(name, assumptions, claim, expected):
    solver = Solver()
    solver.add(*assumptions, Not(claim))
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

base = [original != replacement]
check('detached immutable position remains the validated value', base + [detached, Not(vector_changed), Not(entry_changed)], reported == original, unsat)
check('aliased input can change the reported position', base + [Not(vector_changed), Not(entry_changed)], reported == original, sat)
check('writable vector can change the reported position', base + [detached, Not(entry_changed)], reported == original, sat)
check('writable entry can change the reported position', base + [detached, Not(vector_changed)], reported == original, sat)
check('protected marker stays unchanged', [Not(marker_changed)], Not(marker_changed), unsat)
check('unprotected marker can be changed', [], Not(marker_changed), sat)
