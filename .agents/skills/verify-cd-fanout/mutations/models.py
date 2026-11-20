"""Check weakened fan-out models against their independent invariants."""

import os
from pathlib import Path
import subprocess
import tempfile

models = Path(__file__).resolve().parent.parent / "models"
jar = Path(os.environ["TLA2TOOLS"]).resolve()
cases = [
    (
        "mandatory failure during catch-up",
        "FanoutMandatoryFailure",
        "NoStartsAfterMandatoryFailure",
        "IF Failed THEN {}",
        "IF Failed /\\ ~catchUp THEN {}",
    ),
    (
        "halted pilot start",
        "Fanout",
        "NoNewStartsWhileHalted",
        'StartPilot == /\\ ~halted /\\ pilot = "pending"',
        'StartPilot == /\\ pilot = "pending"',
    ),
    (
        "production before pilot",
        "Fanout",
        "PilotBeforeProduction",
        'StartProd == /\\ ~halted /\\ pilot = "succeeded" /\\ prod = "pending"',
        'StartProd == /\\ ~halted /\\ pilot = "pending" /\\ prod = "pending"',
    ),
    (
        "catch-up bypasses pilot",
        "FanoutCatchup",
        "MandatoryBeforeProduction",
        'ELSE IF catchUp THEN CatchPilot \\cup (IF pilot = "succeeded" THEN CatchProduction ELSE {})',
        'ELSE IF catchUp THEN CatchPilot \\cup CatchProduction',
    ),
    (
        "missing slot completes",
        "FanoutCatchup",
        "MissingIsNotComplete",
        'complete\' = (pilot # "missing" /\\ production # "missing")',
        "complete' = TRUE",
    ),
]

with tempfile.TemporaryDirectory(prefix="hobo-cd-fanout-model-mutants-") as directory:
    scratch = Path(directory)
    for label, name, invariant, before, after in cases:
        model = (models / f"{name}.tla").read_text()
        if model.count(before) != 1:
            raise RuntimeError(f"{label}: mutation site is not unique")
        (scratch / f"{name}.tla").write_text(model.replace(before, after, 1))
        (scratch / f"{name}.cfg").write_text((models / f"{name}.cfg").read_text())
        result = subprocess.run(
            [
                "java",
                "-XX:+UseParallelGC",
                "-cp",
                str(jar),
                "tlc2.TLC",
                "-workers",
                "1",
                "-config",
                f"{name}.cfg",
                f"{name}.tla",
            ],
            cwd=scratch,
            text=True,
            capture_output=True,
            check=False,
        )
        output = result.stdout + result.stderr
        if result.returncode == 0 or f"Invariant {invariant} is violated" not in output:
            raise RuntimeError(f"{label}: expected {invariant} counterexample\n{output}")
        print(f"Expected counterexample: {label} / {invariant}", flush=True)
