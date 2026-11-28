"""Abstract primitive-string stream and local-key alignment.

The proof assumes the same fixed stream prefix and an atomic local fence; it
does not prove parser implementation, storage identity or cross-process safety.
"""
from z3 import And, Bool, Concat, Implies, Not, Or, Solver, String, sat, unsat

first, retry = String('first'), String('retry')
solver = Solver()
solver.add(Concat('run/', first) == Concat('run/', retry), first != retry)
if solver.check() != unsat:
    raise AssertionError('equal prefixed string streams must have equal keys')
print('Proved: a shared stream prefix preserves string identity')

valid, same_key, same_stream = Bool('valid'), Bool('same_key'), Bool('same_stream')
for omit in (False, True):
    solver = Solver()
    solver.add(Implies(valid, same_key == same_stream))
    solver.add(Not(same_key), same_stream)
    if not omit:
        solver.add(valid)
    expected = sat if omit else unsat
    if solver.check() != expected:
        raise AssertionError('unexpected identity-guard result')
    print('Expected counterexample: missing primitive-string guard' if omit else 'Proved: a valid distinct key cannot alias the active stream')
