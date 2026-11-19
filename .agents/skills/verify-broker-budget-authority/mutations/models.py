"""Check that weakened broker models violate their independent invariants."""

import os
from pathlib import Path
import subprocess
import tempfile

models = Path(__file__).resolve().parent.parent / "models"
jar = Path(os.environ["TLA2TOOLS"]).resolve()
timeout = int(os.environ.get("BROKER_MUTATION_TIMEOUT_SEC", "120"))
cases = [
    ("ambiguous commit result", "BrokerCommitResult", "RejectAmbiguous = FALSE\n          FenceUncertain = TRUE\n          FenceThrown = TRUE\n          SeparateCommitFailure = TRUE", "NoPrematureAcknowledgement", None, "BrokerCommitResult.cfg"),
    ("reuse after ambiguous commit", "BrokerCommitResult", "RejectAmbiguous = TRUE\n          FenceUncertain = FALSE\n          FenceThrown = TRUE\n          SeparateCommitFailure = TRUE", "NoUseAfterAmbiguousCommit", None, "BrokerCommitResult.cfg"),
    ("reuse after thrown commit", "BrokerCommitResult", "RejectAmbiguous = TRUE\n          FenceUncertain = TRUE\n          FenceThrown = FALSE\n          SeparateCommitFailure = TRUE", "NoUseAfterThrownCommit", None, "BrokerCommitResult.cfg"),
    ("commit failure reported as denial", "BrokerCommitResult", "RejectAmbiguous = TRUE\n          FenceUncertain = TRUE\n          FenceThrown = TRUE\n          SeparateCommitFailure = FALSE", "NoCommitFailureAsDenial", None, "BrokerCommitResult.cfg"),
    ("reentrant admission", "BrokerCommit", "GuardReentry = FALSE", "NoOverlappingAdmissions", None, "BrokerCommit.cfg"),
    ("active entitlement scope", "BrokerEntitlement", "PreserveScope = FALSE\n          CheckReplayScope = TRUE\n          FenceUncertain = FALSE", "ActiveClaimKeepsScope", None, "BrokerEntitlement.cfg"),
    ("replayed entitlement scope", "BrokerEntitlement", "PreserveScope = TRUE\n          CheckReplayScope = FALSE\n          FenceUncertain = FALSE", "ReplayRejectsMismatch", None, "BrokerEntitlement.cfg"),
    ("unused evidence", "BrokerBudget", "Requests = {1, 2}", "ReleaseNeedsEvidence", (
        '/\\ ((phase[r] = "held") \\/ (phase[r] = "uncertain" /\\ unusedEvidence[r]))\n           /\\ ~claimed[r] /\\ unusedEvidence[r]',
        '/\\ phase[r] \\in {"held", "uncertain"} /\\ ~claimed[r]'), "BrokerBudget.cfg"),
    ("final evidence", "BrokerBudget", "Requests = {1, 2}", "SettlementNeedsEvidence", (
        '/\\ phase[r] \\in {"held", "uncertain"} /\\ claimed[r] /\\ evidence[r]',
        '/\\ phase[r] \\in {"held", "uncertain"} /\\ evidence[r]'), "BrokerBudget.cfg"),
    ("signed settlement", "BrokerFence", None, "SettledRequiresClaimAndProofs", (
        '/\\ phase \\in {"held", "uncertain"} /\\ claimed /\\ Valid(candidate)',
        '/\\ phase \\in {"held", "uncertain"} /\\ claimed'), "BrokerFence.cfg"),
    ("claimed release", "BrokerFence", None, "ClaimedFundsRemainHeld", (
        '/\\ phase \\in {"held", "uncertain"} /\\ ~claimed\n           /\\ (phase = "held" \\/ unusedWitness)\n           /\\ phase\' = "released"',
        '/\\ phase \\in {"held", "uncertain"}\n           /\\ phase\' = "released"'), "BrokerFence.cfg"),
]

for label, name, constants, invariant, mutation, cfg_name in cases:
    with tempfile.TemporaryDirectory(prefix=f"hobo-broker-model-{name}-") as directory:
        scratch = Path(directory)
        original = (models / f"{name}.tla").read_text()
        baseline_cfg = (models / cfg_name).read_text() if constants else (models / cfg_name).read_text()
        (scratch / f"{name}.tla").write_text(original)
        (scratch / "Baseline.cfg").write_text(baseline_cfg)
        baseline = subprocess.run(
            ["java", "-XX:+UseParallelGC", "-cp", str(jar), "tlc2.TLC", "-workers", "1", "-config", "Baseline.cfg", f"{name}.tla"],
            cwd=scratch, text=True, capture_output=True, check=False, timeout=timeout,
        )
        baseline_output = baseline.stdout + baseline.stderr
        if baseline.returncode != 0 or "Invariant" in baseline_output and "is violated" in baseline_output:
            raise RuntimeError(f"{label}: unmutated model failed\n{baseline_output}")
        model = original
        if mutation:
            before, after = mutation
            if model.count(before) != 1:
                raise RuntimeError(f"{label}: mutation site is not unique")
            model = model.replace(before, after, 1)
        (scratch / f"{name}.tla").write_text(model)
        mutant_lines: list[str] = []
        if constants:
            mutant_lines.append(f"CONSTANTS {constants}")
        for line in baseline_cfg.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("CONSTANT"):
                continue
            if stripped.startswith("SPECIFICATION") or stripped.startswith("INVARIANT"):
                continue
            mutant_lines.append(line)
        mutant_lines.extend(["SPECIFICATION Spec", f"INVARIANT {invariant}", ""])
        (scratch / "Mutant.cfg").write_text("\n".join(mutant_lines))
        result = subprocess.run(
            ["java", "-XX:+UseParallelGC", "-cp", str(jar), "tlc2.TLC", "-workers", "1", "-config", "Mutant.cfg", f"{name}.tla"],
            cwd=scratch, text=True, capture_output=True, check=False, timeout=timeout,
        )
        output = result.stdout + result.stderr
        if result.returncode == 0 or f"Invariant {invariant} is violated" not in output:
            raise RuntimeError(f"{label}: expected {invariant} counterexample\n{output}")
        print(f"Expected counterexample: {label} / {invariant}", flush=True)