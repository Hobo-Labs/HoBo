"""Check weakened provider proof obligations against independent properties."""

import os
from pathlib import Path
import subprocess

env = os.environ.copy()
if env.get("BUDGET_Z3_PYTHONPATH"):
    env["PYTHONPATH"] = env["BUDGET_Z3_PYTHONPATH"]
proof = Path(__file__).resolve().parent.parent / "proof/provider_induction.py"
for mutation, failure in [
    ("first-only", "maximum covers earlier and new observations"),
    ("allow-duplicate-allocation", "duplicate reports cannot authorize free allocation"),
]:
    env["CI_PROVIDER_PROOF_MUTATION"] = mutation
    result = subprocess.run(["python3", str(proof)], env=env, text=True, capture_output=True, check=False)
    output = result.stdout + result.stderr
    if result.returncode == 0 or f"FAIL {failure}" not in output:
        raise RuntimeError(f"expected {mutation} proof counterexample\n{output}")
    print(f"Expected proof counterexample: {mutation}", flush=True)
