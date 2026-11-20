"""Exercise broken CI routing implementations in an isolated copy."""

from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[4]
package = root / "packages/ci"
vitest = root / "node_modules/vitest/vitest.mjs"
config = root / ".agents/skills/verify-ci-budget-routing/models/vitest.config.mts"
source_name = "src/routing.ts"
cases = [
    (
        "duplicate provider allocation",
        "providerAccount.reports > 1 && providerAccount.hasAllocation",
        "false",
        "refuses duplicate account reports",
    ),
    (
        "first provider observation",
        "Math.max(previous?.spent ?? 0, accounting.providerSpent)",
        "previous?.spent ?? accounting.providerSpent",
        "uses the highest exposure",
    ),
    (
        "unknown observation time",
        "!Number.isFinite(observed) ||\n\t\tcompleted >= observed",
        "completed >= observed",
        "counts completed usage when the observation time is unknown",
    ),
    (
        "active hold",
        "const held = active.reduce((sum, lease) => sum + lease.reservedPaidMicros, 0);",
        "const held = 0;",
        "counts active holds and unobserved settlement",
    ),
]

with tempfile.TemporaryDirectory(prefix="hobo-ci-budget-code-mutants-") as directory:
    scratch = Path(directory) / "packages/ci"
    scratch.parent.mkdir()
    shutil.copy2(root / "tsconfig.base.json", Path(directory) / "tsconfig.base.json")
    shutil.copytree(package, scratch, ignore=shutil.ignore_patterns("node_modules", "dist", ".turbo"))
    (scratch / "node_modules").symlink_to((package / "node_modules").resolve(), target_is_directory=True)
    source = scratch / source_name
    original = source.read_text()

    def run(pattern):
        return subprocess.run(
            ["node", str(vitest), "run", "test/budget-routing.property.test.ts", "--root", str(scratch), "--config", str(config), "--maxWorkers=1", "--no-file-parallelism", "--testNamePattern", pattern],
            cwd=root, text=True, capture_output=True, check=False,
        )

    for label, before, after, pattern in cases:
        if original.count(before) != 1:
            raise RuntimeError(f"{label}: mutation site is not unique")
        source.write_text(original.replace(before, after, 1))
        result = run(pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or pattern not in output:
            raise RuntimeError(f"{label}: expected generated counterexample\n{output}")
        print(f"Expected generated counterexample: {label}", flush=True)
        source.write_text(original)

    result = run(".*")
    if result.returncode:
        raise RuntimeError(f"restored implementation failed\n{result.stdout}{result.stderr}")
    print("Restored implementation passed", flush=True)
