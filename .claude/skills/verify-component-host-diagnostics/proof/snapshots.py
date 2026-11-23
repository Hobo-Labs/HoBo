"""Prove abstract mutable-cell snapshot obligations, not JavaScript refinement."""
from z3 import Array, Int, IntSort, Select, Solver, Store, sat, unsat

def check(name, assumptions, expected):
    solver = Solver()
    solver.add(*assumptions)
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

heap = Array('heap', IntSort(), IntSort())
owner, returned, replacement = Int('owner'), Int('returned'), Int('replacement')
changed = Select(Store(heap, returned, replacement), owner) != Select(heap, owner)
check('writing a separate cell cannot change the owner cell', [owner != returned, changed], unsat)
check('writing an aliased cell can change the owner cell', [owner == returned, changed], sat)
owner_array, returned_array = Int('owner_array'), Int('returned_array')
check('distinct arrays can still contain an aliased mutable record',
      [owner_array != returned_array, owner == returned, changed], sat)
