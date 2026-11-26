"""Unbounded exact-real eligibility for a shared all-in estimate."""
import os
from z3 import And, If, Not, Or, Reals, Solver, sat, unsat

price0, price1, cap0, cap1, estimate = Reals("price0 price1 cap0 cap1 estimate")
base = [price0 >= 0, price1 >= price0, cap0 >= 0, cap1 >= 0, estimate >= 0]
full0 = If(price0 >= estimate, price0, estimate)
full1 = If(price1 >= estimate, price1, estimate)
eligible0 = full0 <= cap0
eligible1 = full1 <= cap1
mutated = os.environ.get("BUDGET_ESTIMATE_PROOF_MUTATION") == "omit-estimate"
ranked0 = price0 <= cap0 if mutated else eligible0
ranked1 = price1 <= cap1 if mutated else eligible1
choice = If(ranked0, 0, If(ranked1, 1, -1))
probe = Solver(); probe.add(*base)
if probe.check() != sat:
    raise SystemExit("eligibility premises have no witness")
violation = Or(
    And(choice == -1, Or(eligible0, eligible1)),
    And(choice == 0, Not(eligible0)),
    And(choice == 1, Or(Not(eligible1), eligible0)),
)
proof = Solver(); proof.add(*base, violation)
if proof.check() != unsat:
    print("FAIL: selection violates full-estimate eligibility:", proof.model())
    raise SystemExit(1)
print("PASS: selection finds the cheapest affordable full-estimate hold")
