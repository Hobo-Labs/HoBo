"""Check that every removed fan-out proof guard produces a counterexample."""

import os
from pathlib import Path
import subprocess

proof = Path(__file__).resolve().parent.parent / "proof/fanout_induction.py"
cases = [
    ("omit-halt-guard", "FAIL halt prevents a new start"),
    ("omit-pilot-gate", "FAIL production starts only after mandatory success"),
    ("omit-catchup-gate", "FAIL catch-up production starts only after mandatory success"),
    ("omit-mandatory-failure-guard", "FAIL mandatory failure prevents a new start"),
]

for mutation, expected in cases:
    env = os.environ.copy()
    if env.get("BUDGET_Z3_PYTHONPATH"):
        env["PYTHONPATH"] = env["BUDGET_Z3_PYTHONPATH"]
    env["FANOUT_PROOF_MUTATION"] = mutation
    result = subprocess.run(
        ["python3", str(proof)], env=env, text=True, capture_output=True, check=False
    )
    output = result.stdout + result.stderr
    if result.returncode == 0 or expected not in output:
        raise RuntimeError(f"{mutation}: expected proof counterexample\n{output}")
    print(f"Expected proof counterexample: {mutation}", flush=True)
