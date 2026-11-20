"""Inductively verify conservative provider observation aggregation."""
import os
import sys
from z3 import And, Bool, BoolVal, If, Implies, Int, Not, Or, Real, Solver, get_version_string, sat, unsat

if get_version_string() != "4.15.4":
    raise SystemExit(f"expected Z3 4.15.4, got {get_version_string()}")

seen, maximum, new_report, cost, cap = [
    Real(name) for name in ("seen", "maximum", "new_report", "cost", "cap")
]
updated = If(new_report > maximum, new_report, maximum)
if os.environ.get("CI_PROVIDER_PROOF_MUTATION") == "first-only":
    updated = maximum
previous_has_allocation = Bool("previous_has_allocation")
allocation_flag = Or(previous_has_allocation, new_report > 0)
report_count = Int("report_count")
allows_allocation = Or(report_count <= 1, Not(allocation_flag))
if os.environ.get("CI_PROVIDER_PROOF_MUTATION") == "allow-duplicate-allocation":
    allows_allocation = BoolVal(True)


def prove(name, assumptions, conclusion):
    witness = Solver()
    witness.add(*assumptions)
    if witness.check() != sat:
        raise RuntimeError(f"{name}: assumptions are unsatisfiable or unknown")
    solver = Solver()
    solver.add(*assumptions, Not(conclusion))
    result = solver.check()
    if result != unsat:
        print(f"FAIL {name}: {result}")
        if result == sat:
            print(solver.model())
        return False
    print(f"PASS {name}: all exact real values satisfying the assumptions")
    return True


valid = [seen >= 0, maximum >= seen, new_report >= 0]
checks = [
    prove("empty aggregate starts at zero", [new_report >= 0],
          And(If(new_report > 0, new_report, 0) >= 0,
              If(new_report > 0, new_report, 0) >= new_report)),
    prove("maximum covers earlier and new observations", valid,
          And(updated >= seen, updated >= new_report)),
    prove("admission covers every observation", [*valid, cost >= 0, cap >= 0,
          updated + cost <= cap],
          And(seen + cost <= cap, new_report + cost <= cap)),
    prove("allocation flag covers earlier and new reports",
          [seen >= 0, new_report >= 0, Implies(seen > 0, previous_has_allocation)],
          And(Implies(seen > 0, allocation_flag),
              Implies(new_report > 0, allocation_flag))),
    prove("duplicate reports cannot authorize free allocation",
          [seen >= 0, new_report >= 0, Implies(seen > 0, previous_has_allocation),
           report_count >= 2, allows_allocation],
          And(seen == 0, new_report == 0)),
]
print("SCOPE: exact-real aggregation and allocation flags with nonnegative truthful observations; not TypeScript refinement or external billing")
sys.exit(0 if all(checks) else 1)
