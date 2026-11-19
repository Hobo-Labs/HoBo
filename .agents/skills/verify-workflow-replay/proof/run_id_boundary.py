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
for checked in (True, False):
    solver = Solver()
    if checked:
        solver.add(claim)
    solver.add(Not(claim))
    expected = unsat if checked else sat
    if solver.check() != expected:
        raise AssertionError('unexpected run-ID guard result')
    print('Proved: admitted IDs meet the guard' if checked else 'Expected counterexample: missing run-ID guard')

proxy, inspected = Bool('proxy'), Bool('inspected')
inspection_claim = Implies(proxy, Not(inspected))
for checked in (True, False):
    solver = Solver()
    if checked:
        solver.add(inspection_claim)
    solver.add(Not(inspection_claim))
    expected = unsat if checked else sat
    if solver.check() != expected:
        raise AssertionError('unexpected ID inspection result')
    print('Proved: proxy IDs are not inspected' if checked else 'Expected counterexample: inspecting a proxy ID')
