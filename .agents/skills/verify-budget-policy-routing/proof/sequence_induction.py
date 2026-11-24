"""Integer obligations for bounded sequence advancement, not a TypeScript proof."""
import os
import sys
from z3 import And, Ints, Not, Solver, sat, unsat

maximum, sequence, needed, offset, earlier, later = Ints(
    "maximum sequence needed offset earlier later"
)
mutation = os.environ.get("BUDGET_SEQUENCE_PROOF_MUTATION", "")
base = [maximum >= 0, sequence >= 0, sequence <= maximum, needed >= 0]
preflight = [] if mutation == "omit-preflight" else [needed <= maximum - sequence]

def prove(name, assumptions, conclusion):
    witness = Solver()
    witness.add(*assumptions)
    if witness.check() != sat:
        raise AssertionError(f"{name}: assumptions have no witness")
    solver = Solver()
    solver.add(*assumptions, Not(conclusion))
    result = solver.check()
    if result != unsat:
        print(f"FAIL: {name}: {result}")
        if result == sat:
            print(solver.model())
        return False
    print(f"PASS: {name}")
    return True

checks = [
    prove("preflight bounds the final sequence", base + preflight,
          sequence + needed <= maximum),
    prove("every expiry intermediate remains in range",
          base + preflight + [offset >= 0, offset <= needed],
          And(sequence + offset >= 0, sequence + offset <= maximum)),
    prove("distinct mutation positions have distinct fences",
          base + preflight + [earlier >= 0, earlier < later, later <= needed],
          sequence + earlier < sequence + later),
    prove("zero-step replay preserves the sequence", base,
          sequence + 0 == sequence),
]
if not all(checks):
    sys.exit(1)
