"""Check that weakened proof assumptions produce counterexamples."""

import os
from pathlib import Path
import subprocess

proofs = Path(__file__).resolve().parent.parent / "proof"
env = os.environ.copy()
if env.get("BUDGET_Z3_PYTHONPATH"):
    env["PYTHONPATH"] = env["BUDGET_Z3_PYTHONPATH"]
for filename, variable, value, expected in [
    ("broker_induction.py", "BROKER_PROOF_MUTATION", "omit-unresolved", "FAIL admit complete liability bound"),
    ("scope_induction.py", "BROKER_SCOPE_PROOF_MUTATION", "omit-unit", "FAIL revise scope while retaining active claims"),
    ("scope_induction.py", "BROKER_SCOPE_PROOF_MUTATION", "omit-period", "FAIL revise scope while retaining active claims"),
]:
    mutant_env = {**env, variable: value}
    result = subprocess.run(["python3", str(proofs / filename)], env=mutant_env, text=True, capture_output=True, check=False)
    output = result.stdout + result.stderr
    if result.returncode == 0 or expected not in output:
        raise RuntimeError(f"{value}: expected proof counterexample\n{output}")
    print(f"Expected proof counterexample: {value}", flush=True)
