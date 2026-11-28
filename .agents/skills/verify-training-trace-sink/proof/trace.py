"""Prove abstract source and snapshot cell independence."""
from z3 import Array, Int, IntSort, Select, Solver, Store, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

heap = Array('heap', IntSort(), IntSort())
source, snapshot, replacement = Int('source'), Int('snapshot'), Int('replacement')
changed = Select(Store(heap, source, replacement), snapshot) != Select(heap, snapshot)
check('editing a separate source cell preserves the snapshot', [source != snapshot, changed], unsat)
check('editing an aliased source can alter the snapshot', [source == snapshot, changed], sat)
