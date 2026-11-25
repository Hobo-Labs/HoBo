"""Exercise broken broker implementations in an isolated temporary copy."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile

skill = Path(__file__).resolve().parent.parent
root = skill.parents[2]
package = root / "packages/broker"
vitest = root / "node_modules/vitest/vitest.mjs"
config = skill / "models/vitest.config.mts"
properties = "test/budget-authority.property.test.ts"
denials = "test/budget-admission-denial.test.ts"
fenced = "test/fenced-budget-settlement.test.ts"
admission = "admits only when every existing and requested exposure fits"
dimensions = "keeps provider and entitlement exposure within their separate limits"
claimed = "retains claimed or uncertain holds through replay until evidence-backed settlement"
commit = "does not acknowledge an operation when its journal commit fails"
reentry = "serializes journal callbacks that attempt another admission"
ambiguous = "fails closed after a commit returns an asynchronous or ambiguous result"
scope = "preserves the scope of active zero-unit entitlement claims"
signed = "receiver-bound budget settlement generated histories"
authority = "src/budget-authority.ts"
settlement = "src/budget-fence-settlement.ts"
timeout = int(os.environ.get("BROKER_MUTATION_TIMEOUT_SEC", "600"))
cases = [
    ("ambiguous commit result", authority, "committed !== null && Object(committed) === committed", "committed instanceof Promise", properties, ambiguous, True),
    ("uncertain commit reuse", authority, "if (commitOutcomeUncertain)", "if (false && commitOutcomeUncertain)", properties, ambiguous, True),
    ("thrown commit reuse", authority, "} catch (error) {\n\t\t\tcommitOutcomeUncertain = true;\n\t\t\tthrow new Error", "} catch (error) {\n\t\t\tcommitOutcomeUncertain = false;\n\t\t\tthrow new Error", denials, "rejects reuse after a durable commit failure while retaining its cause", False),
    ("commit failure reported as denial", authority, 'throw new Error("budget commit outcome uncertain; reopen the authority", {\n\t\t\t\tcause: error,\n\t\t\t});', "throw error;", denials, "does not classify a commit exception as a denial", True),
    ("unresolved exposure", authority, "current.unresolvedMicros,\n\t\t\t\t\tcurrent.recoveryReserveMicros", "0,\n\t\t\t\t\tcurrent.recoveryReserveMicros", properties, admission, True),
    ("provider holds", authority, "account.reservedMicros,\n\t\t\t\t\t\taccount.externalCommittedMicros", "0,\n\t\t\t\t\t\taccount.externalCommittedMicros", properties, dimensions, True),
    ("entitlement holds", authority, "add(bucket.reservedUnits, claim.units)", "add(0, claim.units)", properties, dimensions, True),
    ("claimed release", authority, 'status === "released" && existing.executionDigest', 'status === "released" && false', properties, claimed, True),
    ("commit before state", authority, "\t\tcommitting = true;", "\t\tcurrent = clone(BudgetLedgerSnapshotSchema, next);\n\t\treservations = new Map(rows);\n\t\tcommitting = true;", properties, commit, True),
    ("reentrant commit", authority, 'if (committing) throw new Error("budget authority mutation during commit");', 'if (false) throw new Error("budget authority mutation during commit");', properties, reentry, True),
    ("zero-unit configuration", authority, "active().some((row) =>\n\t\t\t\t\t\t\trow.entitlementClaims.some((claim) =>\n\t\t\t\t\t\t\t\tsameEntitlementScope(claim, old),\n\t\t\t\t\t\t\t),\n\t\t\t\t\t\t)", "false", properties, scope, True),
    ("replayed unit", authority, "[row.kind, row.bucketId, row.unit]);", "[row.kind, row.bucketId]);", properties, scope, True),
    ("replayed period", authority, "(row.identity === undefined ||\n\t\t\t\t\t\t\t\t\tbucket.periodId === row.identity.periodId),", "true,", properties, scope, True),
    ("receiver signature", settlement, "!verify(\n\t\t\t\tnull,\n\t\t\t\tBuffer.from(canonicalFenceOperationReceipt(body)),", "false && !verify(\n\t\t\t\tnull,\n\t\t\t\tBuffer.from(canonicalFenceOperationReceipt(body)),", fenced, signed, True),
    ("finance signature", settlement, "!verify(\n\t\t\t\tnull,\n\t\t\t\tBuffer.from(payload),", "false && !verify(\n\t\t\t\tnull,\n\t\t\t\tBuffer.from(payload),", fenced, signed, True),
]


def killed(property_run, output: str) -> bool:
    if property_run:
        return "Property failed after" in output
    return "AssertionError" in output or "Property failed after" in output


with tempfile.TemporaryDirectory(prefix="hobo-broker-code-mutants-") as directory:
    scratch = Path(directory) / "packages/broker"
    cache = Path(directory) / "vitest-cache"
    scratch.parent.mkdir()
    cache.mkdir()
    shutil.copy2(root / "tsconfig.base.json", Path(directory) / "tsconfig.base.json")
    shutil.copytree(package, scratch, ignore=shutil.ignore_patterns("node_modules", "dist", ".turbo"))
    (scratch / "node_modules").symlink_to((package / "node_modules").resolve(), target_is_directory=True)
    original = {name: (scratch / name).read_text() for name in (authority, settlement)}
    run_env = os.environ.copy()
    run_env["BROKER_MUTANT_CACHE"] = str(cache)

    def run(test_file, pattern):
        return subprocess.run(
            ["node", str(vitest), "run", test_file, "--root", str(scratch), "--config", str(config), "--maxWorkers=1", "--no-file-parallelism", "--testNamePattern", pattern],
            cwd=root, env=run_env, text=True, capture_output=True, check=False, timeout=timeout,
        )

    for label, name, before, after, test_file, pattern, property_run in cases:
        for filename, content in original.items():
            (scratch / filename).write_text(content)
        content = original[name]
        if content.count(before) != 1:
            raise RuntimeError(f"{label}: mutation site is not unique")
        (scratch / name).write_text(content.replace(before, after, 1))
        result = run(test_file, pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or not killed(property_run, output):
            raise RuntimeError(f"{label}: expected generated counterexample\n{output}")
        print(f"Expected generated counterexample: {label}", flush=True)
    for filename, content in original.items():
        (scratch / filename).write_text(content)
    for test_file in (properties, denials, fenced):
        result = run(test_file, ".*")
        if result.returncode:
            raise RuntimeError(f"restored {test_file} failed\n{result.stdout}{result.stderr}")
        print(f"Restored implementation passed: {test_file}", flush=True)
