"""Unbounded ordered-identity obligation for deterministic tie-breaking."""
import os
from z3 import If, Ints, Or, Solver, sat, unsat

left, right = Ints("left right")
probe = Solver(); probe.add(left != right)
if probe.check() != sat:
    raise SystemExit("ordering premises have no witness")
first = If(left <= right, left, right)
mutated = os.environ.get("DISPATCH_ORDER_PROOF_MUTATION") == "reverse"
second = If(right >= left, right, left) if mutated else If(right <= left, right, left)
proof = Solver(); proof.add(Or(first != second, first > left, first > right))
if proof.check() != unsat:
    print("FAIL: tie winner depends on input order:", proof.model())
    raise SystemExit(1)
print("PASS: the minimum identity is stable under reversed input order")
