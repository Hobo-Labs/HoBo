"""Exercise weakened promotion implementations in an isolated package copy."""

from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[4]
package = root / "packages/cd"
vitest = root / "node_modules/vitest/vitest.mjs"
config = root / ".agents/skills/verify-promotion-verification/models/vitest.config.mts"
cases = [
    (
        "verification pass guard",
        "if (result.verdict !== VerificationVerdict.PASS)",
        "if (false)",
        "never requests qualification",
        "test/promotion/verification.property.test.ts",
    ),
    (
        "post-append request binding",
        "if (!sameRequest(persisted, input, intent, preview))",
        "if (false)",
        "refuses one of two different requests",
        "test/promotion/request-binding.property.test.ts",
    ),
    (
        "rollback request binding",
        "if (reservation.meta?.rollbackRequestFingerprint !== fingerprint)",
        "if (false)",
        "claims a rollback key",
        "test/promotion/request-binding.property.test.ts",
    ),
    (
        "rollback current-Set guard",
        "rollbackId,\n\t\t\t\t\tctx,\n\t\t\t\t\ttrue,",
        "rollbackId,\n\t\t\t\t\tctx,\n\t\t\t\t\tfalse,",
        "does not undo a Set installed",
        "test/promotion/request-binding.property.test.ts",
    ),
    (
        "target execution order",
        "version: 1,\n\t\t\t\tfreightId: input.freightId,\n\t\t\t\ttargets: [...input.targets],",
        "version: 1,\n\t\t\t\tfreightId: input.freightId,\n\t\t\t\ttargets: [...input.targets].sort(),",
        "binds the target execution order",
        "test/promotion/request-binding.property.test.ts",
    ),
]

with tempfile.TemporaryDirectory(prefix="hobo-promotion-code-mutants-") as directory:
    scratch_root = Path(directory)
    scratch = scratch_root / "packages/cd"
    scratch.parent.mkdir()
    shutil.copy2(root / "tsconfig.base.json", scratch_root / "tsconfig.base.json")
    shutil.copytree(
        package,
        scratch,
        ignore=shutil.ignore_patterns("node_modules", "dist", ".turbo"),
    )
    (scratch / "node_modules").symlink_to(
        (package / "node_modules").resolve(), target_is_directory=True
    )
    source = scratch / "src/promotion/service.ts"
    original = source.read_text()

    def run(test_file, pattern):
        return subprocess.run(
            [
                "node",
                str(vitest),
                "run",
                test_file,
                "--root",
                str(scratch),
                "--config",
                str(config),
                "--maxWorkers=1",
                "--no-file-parallelism",
                "--testNamePattern",
                pattern,
            ],
            cwd=root,
            text=True,
            capture_output=True,
            check=False,
        )

    for label, before, after, pattern, test_file in cases:
        if original.count(before) != 1:
            raise RuntimeError(f"{label}: mutation site is not unique")
        source.write_text(original.replace(before, after, 1))
        result = run(test_file, pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or pattern not in output:
            raise RuntimeError(f"{label}: expected generated counterexample\n{output}")
        print(f"Expected generated counterexample: {label}", flush=True)
        source.write_text(original)

    for test_file in {
        "test/promotion/request-binding.property.test.ts",
        "test/promotion/verification.property.test.ts",
    }:
        result = run(test_file, ".*")
        if result.returncode:
            raise RuntimeError(
                f"restored implementation failed\n{result.stdout}{result.stderr}"
            )
    print("Restored implementation passed", flush=True)
