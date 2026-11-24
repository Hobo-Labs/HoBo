"""Unbounded arithmetic obligation for category-scoped budget holds."""
import os
from z3 import If, Ints, Or, Reals, Solver, sat, unsat

target, chosen = Ints("target chosen")
held, liability, cap, cost = Reals("held liability cap cost")
base = [held >= 0, liability >= 0, liability <= held, cap >= held,
        cost > 0, held + cost <= cap]
mutated = os.environ.get("BUDGET_SCOPE_PROOF_MUTATION") == "wrong-category"
base.append(chosen != target if mutated else chosen == target)
probe = Solver()
probe.add(*base)
if probe.check() != sat:
    raise SystemExit("scope proof premises have no witness")
next_held = If(chosen == target, held + cost, held)
next_liability = liability + cost
proof = Solver()
proof.add(*base, Or(next_liability > next_held, next_held > cap))
result = proof.check()
if result != unsat:
    print("FAIL: selected category does not preserve held liability:", proof.model())
    raise SystemExit(1)
print("PASS: an admissible same-category reservation preserves coverage and cap")
