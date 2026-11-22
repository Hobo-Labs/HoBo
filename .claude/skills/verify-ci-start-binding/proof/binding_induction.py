"""Induction over abstract atomic job-to-slot bindings, with unbounded IDs."""
import os
import z3

owner = z3.Array('owner', z3.IntSort(), z3.IntSort())
j, slot, x, y = z3.Ints('j slot x y')
none = -1
unique_at_witnesses = z3.Implies(z3.And(x != y, owner[x] != none), owner[x] != owner[y])
slot_unused_at_witnesses = z3.And(owner[x] != slot, owner[y] != slot)
assumptions = [unique_at_witnesses, owner[j] == none, slot != none]
if os.getenv('START_BINDING_PROOF_MUTATION') != 'omit-slot-guard':
    assumptions.append(slot_unused_at_witnesses)
updated = z3.Store(owner, j, slot)
violation = z3.And(x != y, updated[x] != none, updated[x] == updated[y])
solver = z3.Solver()
solver.add(*assumptions, violation)
result = solver.check()
if result != z3.unsat:
    print(f'FAIL: atomic binding can assign one slot to two jobs ({result})')
    if result == z3.sat:
        print(solver.model())
    raise SystemExit(1)
print('PASS: an atomic binding preserves unique slot ownership for unbounded job and slot IDs')
