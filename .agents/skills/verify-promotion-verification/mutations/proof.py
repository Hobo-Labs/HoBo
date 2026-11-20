"""Check that omitting the binding proof guard produces a counterexample."""

import os
from pathlib import Path
import subprocess

env = os.environ.copy()
if env.get("BUDGET_Z3_PYTHONPATH"):
    env["PYTHONPATH"] = env["BUDGET_Z3_PYTHONPATH"]
env["PROMOTION_PROOF_MUTATION"] = "omit-binding-check"
proof = Path(__file__).resolve().parent.parent / "proof/binding_induction.py"
result = subprocess.run(
    ["python3", str(proof)], env=env, text=True, capture_output=True, check=False
)
output = result.stdout + result.stderr
if result.returncode == 0 or "FAIL acknowledgement matches claimed identity" not in output:
    raise RuntimeError(f"expected binding proof counterexample\n{output}")
print("Expected proof counterexample: omitted binding check", flush=True)
