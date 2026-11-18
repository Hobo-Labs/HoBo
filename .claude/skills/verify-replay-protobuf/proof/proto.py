"""Abstract validation obligations for protobuf replay evidence.

Assumes honest wire classification and decoded integer values; it does not
verify the JavaScript parser, protobuf library, or pre-parsed JSON numbers.
"""
from z3 import And, Bool, If, Int, Not, Or, Solver, sat, unsat

value = Int('value')
limit = 9007199254740991
safe = And(value >= 0, value <= limit)

def check(name, assumptions, claim, expected):
    solver = Solver()
    solver.add(*assumptions, Not(claim))
    actual = solver.check()
    if actual != expected:
        raise AssertionError(f'{name}: expected {expected}, got {actual}')
    print(f"{'Proved' if expected == unsat else 'Expected counterexample'}: {name}")

check('accepted decoded position stays inside safe bounds', [safe], safe, unsat)
check('missing the lower bound permits a negative position', [value <= limit], safe, sat)
check('missing the upper bound permits an unsafe position', [value >= 0], safe, sat)

wire_overflow = Bool('wire_overflow')
wire_checked = Bool('wire_checked')
accepted = Not(And(wire_checked, wire_overflow))
check('checked overflow cannot be accepted', [wire_checked, wire_overflow], Not(accepted), unsat)
check('unchecked wire overflow can appear acceptable', [Not(wire_checked), wire_overflow], Not(accepted), sat)

present = Bool('marker_present')
version = Int('version')
valid_marker = Or(And(Not(present), version == 1), And(present, Or(version == 1, version == 2)))
check('legacy default and known marker retain their meaning', [valid_marker], Or(version == 1, version == 2), unsat)
check('unvalidated marked version can be unsupported', [present], Or(version == 1, version == 2), sat)

input_empty = Bool('input_empty')
copy_empty = Bool('copy_empty')
output_empty = And(input_empty, copy_empty)
check('preserved empty collections remain empty', [input_empty, copy_empty], output_empty, unsat)
check('dropping empty-collection preservation breaks equality', [input_empty], output_empty, sat)

captured = Int('captured')
checked = Int('checked')
decoded = Int('decoded')
check('validated capture equals decoded capture', [checked == captured, decoded == captured], checked == decoded, unsat)
check('decoding the live input can differ from the checked capture', [checked == captured], checked == decoded, sat)
