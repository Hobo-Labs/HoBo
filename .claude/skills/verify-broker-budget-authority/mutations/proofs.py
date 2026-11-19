"""Check that weakened proof assumptions produce counterexamples."""

import os
import sys
from pathlib import Path
import subprocess

proofs = Path(__file__).resolve().parent.parent / "proof"
timeout = int(os.environ.get("BROKER_MUTATION_TIMEOUT_SEC", "120"))


def merged_pythonpath() -> str:
    extra = os.environ.get("BUDGET_Z3_PYTHONPATH", "")
    if not extra:
        return os.environ.get("PYTHONPATH", "")
    base = os.environ.get("PYTHONPATH", "")
    return f"{extra}{os.pathsep}{base}" if base else extra


def run(script: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    run_env = {**env, "PYTHONPATH": merged_pythonpath()}
    return subprocess.run(
        [sys.executable, str(proofs / script)],
        env=run_env,
        text=True,
        capture_output=True,
        check=False,
        timeout=timeout,
    )


base_env = {k: v for k, v in os.environ.items() if k not in ("BROKER_PROOF_MUTATION", "BROKER_SCOPE_PROOF_MUTATION")}
for filename in ("broker_induction.py", "scope_induction.py"):
    result = run(filename, base_env)
    output = result.stdout + result.stderr
    if result.returncode != 0:
        raise RuntimeError(f"baseline {filename} failed\n{output}")
    if "FAIL " in output:
        raise RuntimeError(f"baseline {filename} reported failure\n{output}")
    print(f"Baseline proof passed: {filename}", flush=True)

for filename, variable, value, expected in [
    ("broker_induction.py", "BROKER_PROOF_MUTATION", "omit-unresolved", "FAIL admit complete liability bound"),
    ("scope_induction.py", "BROKER_SCOPE_PROOF_MUTATION", "omit-unit", "FAIL revise scope while retaining active claims"),
    ("scope_induction.py", "BROKER_SCOPE_PROOF_MUTATION", "omit-period", "FAIL revise scope while retaining active claims"),
]:
    mutant_env = {**base_env, variable: value}
    result = run(filename, mutant_env)
    output = result.stdout + result.stderr
    if result.returncode == 0 or expected not in output:
        raise RuntimeError(f"{value}: expected proof counterexample\n{output}")
    print(f"Expected proof counterexample: {value}", flush=True)