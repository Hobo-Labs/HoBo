"""Check weakened CI budget models against independent invariants."""

import os
from pathlib import Path
import subprocess
import tempfile

models = Path(__file__).resolve().parent.parent / "models"
jar = Path(os.environ["TLA2TOOLS"]).resolve()
cases = [
    (
        "duplicate provider allocation",
        "CiProviderAllocation",
        "NoOverstatedAllocation",
        "IF \\E i \\in 1..2 : available[i] > 0",
        "IF FALSE",
    ),
    (
        "first provider observation",
        "CiProviderSnapshots",
        "AllReportsCounted",
        "exposure' = MaxReport",
        "exposure' = reported[first]",
    ),
    (
        "active hold",
        "CiBudget",
        "OfferFitsBudget",
        'Offer == /\\ phase = "queued" /\\ observed + active + local + 1 <= Cap',
        'Offer == /\\ phase = "queued" /\\ observed + local + 1 <= Cap',
    ),
]

with tempfile.TemporaryDirectory(prefix="hobo-ci-budget-model-mutants-") as directory:
    scratch = Path(directory)
    for label, name, invariant, before, after in cases:
        model = (models / f"{name}.tla").read_text()
        if model.count(before) != 1:
            raise RuntimeError(f"{label}: mutation site is not unique")
        (scratch / f"{name}.tla").write_text(model.replace(before, after, 1))
        config = (models / f"{name}.cfg").read_text()
        (scratch / f"{name}.cfg").write_text(config)
        result = subprocess.run(
            ["java", "-XX:+UseParallelGC", "-cp", str(jar), "tlc2.TLC", "-workers", "1", "-config", f"{name}.cfg", f"{name}.tla"],
            cwd=scratch, text=True, capture_output=True, check=False,
        )
        output = result.stdout + result.stderr
        if result.returncode == 0 or f"Invariant {invariant} is violated" not in output:
            raise RuntimeError(f"{label}: expected {invariant} counterexample\n{output}")
        print(f"Expected counterexample: {label} / {invariant}", flush=True)
