"""Exercise broken broker implementations in an isolated temporary copy."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[4]
package = root / "packages/broker"
vitest = root / "node_modules/vitest/vitest.mjs"
config = root / ".agents/skills/verify-broker-budget-authority/models/vitest.config.mts"
properties = "test/budget-authority.property.test.ts"
fenced = "test/fenced-budget-settlement.test.ts"
admission = "admits only when every existing and requested exposure fits"
dimensions = "keeps provider and entitlement exposure within their separate limits"
claimed = "retains claimed or uncertain holds through replay until evidence-backed settlement"
commit = "does not acknowledge an operation when its journal commit fails"
reentry = "serializes journal callbacks that attempt another admission"
scope = "preserves the scope of active zero-unit entitlement claims"
signed = "receiver-bound budget settlement generated histories"
authority = "src/budget-authority.ts"
settlement = "src/budget-fence-settlement.ts"
cases = [
    ("unresolved exposure", authority, "current.unresolvedMicros,\n\t\t\t\t\tcurrent.recoveryReserveMicros", "0,\n\t\t\t\t\tcurrent.recoveryReserveMicros", properties, admission),
    ("provider holds", authority, "account.reservedMicros,\n\t\t\t\t\t\taccount.externalCommittedMicros", "0,\n\t\t\t\t\t\taccount.externalCommittedMicros", properties, dimensions),
    ("entitlement holds", authority, "add(bucket.reservedUnits, claim.units)", "add(0, claim.units)", properties, dimensions),
    ("claimed release", authority, 'status === "released" && existing.executionDigest', 'status === "released" && false', properties, claimed),
    ("commit before state", authority, "\t\tcommitting = true;", "\t\tcurrent = clone(BudgetLedgerSnapshotSchema, next);\n\t\treservations = new Map(rows);\n\t\tcommitting = true;", properties, commit),
    ("reentrant commit", authority, 'if (committing) throw new Error("budget authority mutation during commit");', 'if (false) throw new Error("budget authority mutation during commit");', properties, reentry),
    ("zero-unit configuration", authority, "active().some((row) =>\n\t\t\t\t\t\trow.entitlementClaims.some(\n\t\t\t\t\t\t\t(claim) => claim.bucketId === old.bucketId,\n\t\t\t\t\t\t),\n\t\t\t\t\t)", "old.reservedUnits > 0", properties, scope),
    ("replayed unit", authority, "bucket.unit === entry.unit &&", "true &&", properties, scope),
    ("replayed period", authority, "bucket.periodId === row.identity?.periodId,", "true,", properties, scope),
    ("receiver signature", settlement, "!verify(\n\t\t\t\tnull,\n\t\t\t\tBuffer.from(canonicalFenceOperationReceipt(body)),", "false && !verify(\n\t\t\t\tnull,\n\t\t\t\tBuffer.from(canonicalFenceOperationReceipt(body)),", fenced, signed),
    ("finance signature", settlement, "!verify(\n\t\t\t\tnull,\n\t\t\t\tBuffer.from(payload),", "false && !verify(\n\t\t\t\tnull,\n\t\t\t\tBuffer.from(payload),", fenced, signed),
]

with tempfile.TemporaryDirectory(prefix="hobo-broker-code-mutants-") as directory:
    scratch = Path(directory) / "packages/broker"
    scratch.parent.mkdir()
    shutil.copy2(root / "tsconfig.base.json", Path(directory) / "tsconfig.base.json")
    shutil.copytree(package, scratch, ignore=shutil.ignore_patterns("node_modules", "dist", ".turbo"))
    (scratch / "node_modules").symlink_to((package / "node_modules").resolve(), target_is_directory=True)
    original = {name: (scratch / name).read_text() for name in (authority, settlement)}

    def run(test_file, pattern):
        return subprocess.run(
            ["node", str(vitest), "run", test_file, "--root", str(scratch), "--config", str(config), "--maxWorkers=1", "--no-file-parallelism", "--testNamePattern", pattern],
            cwd=root, env=os.environ.copy(), text=True, capture_output=True, check=False,
        )

    for label, name, before, after, test_file, pattern in cases:
        for filename, content in original.items():
            (scratch / filename).write_text(content)
        content = original[name]
        if content.count(before) != 1:
            raise RuntimeError(f"{label}: mutation site is not unique")
        (scratch / name).write_text(content.replace(before, after, 1))
        result = run(test_file, pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or "Property failed after" not in output:
            raise RuntimeError(f"{label}: expected generated counterexample\n{output}")
        print(f"Expected generated counterexample: {label}", flush=True)
    for filename, content in original.items():
        (scratch / filename).write_text(content)
    for test_file in (properties, fenced):
        result = run(test_file, ".*")
        if result.returncode:
            raise RuntimeError(f"restored {test_file} failed\n{result.stdout}{result.stderr}")
        print(f"Restored implementation passed: {test_file}", flush=True)
