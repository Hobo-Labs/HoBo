"""Exact-instant latest-selection determinism for arbitrary timestamps and values."""
import os
from z3 import If, Int, Or, Real, Solver, sat, unsat

ta, tb = Int('time_a'), Int('time_b')
a, b = Real('value_a'), Real('value_b')
mutated=os.environ.get('PRICING_LATEST_PROOF_MUTATION') == 'allow-conflict'
assumptions=[] if mutated else [Or(ta != tb,a == b)]
first_ab=If(ta >= tb,a,b); first_ba=If(tb >= ta,b,a)
witness=Solver();witness.add(*assumptions,ta==tb,a==b)
if witness.check()!=sat: raise SystemExit('latest-selection premises have no witness')
proof=Solver();proof.add(*assumptions,first_ab != first_ba)
if proof.check()!=unsat:
 print('FAIL: latest value changes with input order:',proof.model())
 raise SystemExit(1)
print('PASS: an unambiguous latest value is independent of input order')
