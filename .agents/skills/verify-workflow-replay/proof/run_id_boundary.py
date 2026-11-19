"""Abstract primitive run identities and fixed-prefix stream names."""
from z3 import Bool, Concat, Implies, Not, Solver, String, sat, unsat

first, second = String('first'), String('second')
solver = Solver()
solver.add(Concat('run/', first) == Concat('run/', second), first != second)
if solver.check() != unsat:
    raise AssertionError('equal prefixed strings must have equal IDs')
print('Proved: a shared stream prefix preserves string identity')

primitive, nonempty, admitted = Bool('primitive'), Bool('nonempty'), Bool('admitted')
claim = Implies(admitted, primitive & nonempty)
solver = Solver()
solver.add(admitted, Not(primitive))
if solver.check() != sat:
    raise AssertionError('expected counterexample when admitted IDs skip primitive guard')
print('Expected counterexample: missing run-ID guard')

proxy, inspected = Bool('proxy'), Bool('inspected')
inspection_claim = Implies(proxy, Not(inspected))
solver = Solver()
solver.add(proxy, inspected)
if solver.check() != sat:
    raise AssertionError('expected counterexample when proxy IDs are inspected')
print('Expected counterexample: inspecting a proxy ID')