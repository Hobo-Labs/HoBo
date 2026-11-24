"""Prove a shared-revision CAS fence for any number of abstract contenders."""

import os
import sys

from z3 import And, Ints, Not, Solver, sat, unsat, get_version_string

if get_version_string() != "4.15.4":
    raise SystemExit(f"expected Z3 4.15.4, got {get_version_string()}")

base, seq, accepted = Ints("base seq accepted")


def invariant(revision, successes):
    return And(base >= 0, successes >= 0, successes <= 1,
               revision >= base + successes)


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
    print(f"PASS {name}: all integers satisfying the assumptions")
    return True


state = invariant(seq, accepted)
admit = [state]
if os.environ.get("CAPACITY_PROOF_MUTATION") != "omit-revision-guard":
    admit.append(seq == base)
checks = [
    prove("initial snapshot", [base >= 0], invariant(base, 0)),
    prove("accepted shared-revision reservation", admit,
          invariant(seq + 1, accepted + 1)),
    prove("another transaction advances revision", [state],
          invariant(seq + 1, accepted)),
    prove("refused or idle contender", [state], invariant(seq, accepted)),
]
maximum = 0xffffffff
bounded_advance = [seq >= 0, seq <= maximum]
if os.environ.get("CAPACITY_PROOF_MUTATION") != "omit-limit-guard":
    bounded_advance.append(seq < maximum)
checks.append(prove("bounded revision advance", bounded_advance,
                    And(seq + 1 > seq, seq + 1 <= maximum)))
print("SCOPE: assumes atomic compare-and-increment and no resetting revisions")
sys.exit(0 if all(checks) else 1)
