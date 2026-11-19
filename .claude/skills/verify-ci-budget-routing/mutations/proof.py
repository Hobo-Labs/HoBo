"""Check that a first-observation proof mutation produces a counterexample."""

import os
from pathlib import Path
import subprocess

env = os.environ.copy()
if env.get("BUDGET_Z3_PYTHONPATH"):
    env["PYTHONPATH"] = env["BUDGET_Z3_PYTHONPATH"]
env["CI_PROVIDER_PROOF_MUTATION"] = "first-only"
proof = Path(__file__).resolve().parent.parent / "proof/provider_induction.py"
result = subprocess.run(["python3", str(proof)], env=env, text=True, capture_output=True, check=False)
output = result.stdout + result.stderr
if result.returncode == 0 or "FAIL maximum covers earlier and new observations" not in output:
    raise RuntimeError(f"expected first-only proof counterexample\n{output}")
print("Expected proof counterexample: first provider observation", flush=True)
