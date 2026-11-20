"""Exercise weakened fan-out schedulers in an isolated package copy."""

from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[4]
package = root / "packages/cd"
vitest = root / "node_modules/vitest/vitest.mjs"
config = root / ".agents/skills/verify-cd-fanout/models/vitest.config.mts"
cases = [
    (
        "mandatory failure during catch-up",
        "free === 0 || mandatoryFailed",
        "free === 0 || (mandatoryFailed && !options.catchUp)",
        "stops all new starts after a mandatory failure",
    ),
    (
        "halt guard",
        "options.halted || free === 0",
        "free === 0",
        "only offers mandatory camps",
    ),
    (
        "mandatory group scope",
        "const scope = mandatoryGate ? mandatory : plan.groups;",
        "const scope = plan.groups;",
        "only offers mandatory camps",
    ),
    (
        "catch-up mandatory gate",
        "candidates: (mandatoryGate ? mandatoryCamps : all).filter(",
        "candidates: all.filter(",
        "keeps mandatory gating during catch-up",
    ),
    (
        "missing slot completion",
        "if (stateOf(slots, campId) === state) n += 1;",
        "if (slots.get(campId)?.state === state) n += 1;",
        "keeps mandatory gating during catch-up",
    ),
]

with tempfile.TemporaryDirectory(prefix="hobo-cd-fanout-code-mutants-") as directory:
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
    source = scratch / "src/fanout/schedule.ts"
    original = source.read_text()

    def run(pattern):
        return subprocess.run(
            [
                "node",
                str(vitest),
                "run",
                "test/fanout/schedule.property.test.ts",
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
        raise RuntimeError(
            f"restored implementation failed\n{result.stdout}{result.stderr}"
        )
    print("Restored implementation passed", flush=True)
