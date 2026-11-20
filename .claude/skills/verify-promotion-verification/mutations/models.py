"""Check weakened promotion models against independent invariants."""

import os
from pathlib import Path
import subprocess
import tempfile

models = Path(__file__).resolve().parent.parent / "models"
jar = Path(os.environ["TLA2TOOLS"]).resolve()
cases = [
    (
        "qualification without pass",
        "Promotion",
        "QualificationRequiresPass",
        'Qualify == /\\ phase = "verified" /\\ verdict = "pass" /\\ qualified\' = TRUE\n           /\\ phase\' = "qualified" /\\ UNCHANGED verdict',
        'Qualify == /\\ phase \\in {"verified", "compensating"} /\\ qualified\' = TRUE\n           /\\ phase\' = "qualified" /\\ UNCHANGED verdict',
    ),
    (
        "accept every binding",
        "PromotionBinding",
        "NoFalseAcknowledgement",
        '/\\ phase\' = [phase EXCEPT ![c] = IF journal = Identity(c) THEN "accepted" ELSE "rejected"]',
        '/\\ phase\' = [phase EXCEPT ![c] = "accepted"]',
    ),
    (
        "reject every binding",
        "PromotionBinding",
        "NoFalseRejection",
        '/\\ phase\' = [phase EXCEPT ![c] = IF journal = Identity(c) THEN "accepted" ELSE "rejected"]',
        '/\\ phase\' = [phase EXCEPT ![c] = "rejected"]',
    ),
    (
        "repeat rollback after Set change",
        "RollbackRetry",
        "NoSecondSetChange",
        '/\\ claimed /\\ ~recorded /\\ current = base /\\ effects < 2',
        '/\\ claimed /\\ ~recorded /\\ effects < 2',
    ),
]

with tempfile.TemporaryDirectory(prefix="hobo-promotion-model-mutants-") as directory:
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
