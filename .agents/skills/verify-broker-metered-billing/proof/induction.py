#!/usr/bin/env python3
"""Exact-real abstraction of the single-writer metered budget aggregate."""
import os
import sys
from z3 import And, Not, Real, Solver, sat, unsat

spent, held, cap, request, retired, actual = [Real(x) for x in
    ("spent", "held", "cap", "request", "retired", "actual")]
mutation = os.environ.get("METERED_PROOF_MUTATION", "")
assumptions = [spent >= 0, held >= 0, cap >= 0, spent + held <= cap]

def check(name, premises, conclusion):
    witness = Solver()
    witness.add(*premises)
    if witness.check() != sat:
        raise RuntimeError(f"{name}: premises have no witness")
    solver = Solver()
    solver.add(*premises, Not(conclusion))
    if solver.check() != unsat:
        print(f"FAIL {name}: {solver.model()}")
        return False
    print(f"PASS {name}: all exact-real values satisfying the assumptions")
    return True

admission_guard = (spent + request <= cap if mutation == "omit-held"
                   else spent + held + request <= cap)
usage_guard = (actual >= 0 if mutation == "ignore-overrun"
               else And(actual >= 0, actual <= retired))
results = [
    check("admit a fresh hold", assumptions + [request >= 0, admission_guard],
          spent + held + request <= cap),
    check("release confirmed unused funds", assumptions + [retired >= 0, retired <= held],
          spent + held - retired <= cap),
    check("replace a hold with final usage", assumptions + [retired >= 0, retired <= held, usage_guard],
          spent + actual + held - retired <= cap),
]
print("SCOPE: outside charges, provider overruns, forged facts, persistence and TypeScript refinement are not proven")
if not all(results):
    sys.exit(1)
