"""Abstract primitive identity and journal stream binding obligations."""
from z3 import And, Bool, If, Implies, Not, Solver, sat, unsat

primitive = Bool('primitive')
nonempty = Bool('nonempty')
needs_nonempty = Bool('needs_nonempty')
check_primitive = Bool('check_primitive')
check_nonempty = Bool('check_nonempty')
accepted = And(Implies(check_primitive, primitive), Implies(check_nonempty, Implies(needs_nonempty, nonempty)))
valid = And(primitive, Implies(needs_nonempty, nonempty))

def check(name, assumptions, expected):
 solver=Solver(); solver.add(*assumptions); actual=solver.check()
 if actual != expected: raise AssertionError(f'{name}: expected {expected}, got {actual}')
 print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

check('checks imply a primitive valid identity', [check_primitive, check_nonempty, accepted, Not(valid)], unsat)
check('without primitive check a boxed value can pass', [Not(check_primitive), check_nonempty, accepted, Not(primitive)], sat)
check('without nonempty check an empty identity can pass', [check_primitive, Not(check_nonempty), accepted, needs_nonempty, Not(nonempty)], sat)

captured_foreign=Bool('captured_foreign')
live_foreign=Bool('live_foreign')
use_capture=Bool('use_capture')
used_foreign=If(use_capture,captured_foreign,live_foreign)
check('checked captured journal never uses a foreign stream', [Not(captured_foreign), use_capture, used_foreign], unsat)
check('omitting stream validation can use foreign evidence', [use_capture, used_foreign], sat)
check('using a changed live journal can use foreign evidence', [Not(captured_foreign), Not(use_capture), used_foreign], sat)
