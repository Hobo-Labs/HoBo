"""Check that weakened broker models violate their independent invariants."""

import os
from pathlib import Path
import subprocess
import tempfile

models = Path(__file__).resolve().parent.parent / "models"
jar = Path(os.environ["TLA2TOOLS"]).resolve()
cases = [
    ("ambiguous commit result", "BrokerCommitResult", "RejectAmbiguous = FALSE\n          FenceUncertain = TRUE\n          FenceThrown = TRUE", "NoPrematureAcknowledgement", None),
    ("reuse after ambiguous commit", "BrokerCommitResult", "RejectAmbiguous = TRUE\n          FenceUncertain = FALSE\n          FenceThrown = TRUE", "NoUseAfterAmbiguousCommit", None),
    ("reuse after thrown commit", "BrokerCommitResult", "RejectAmbiguous = TRUE\n          FenceUncertain = TRUE\n          FenceThrown = FALSE", "NoUseAfterThrownCommit", None),
    ("reentrant admission", "BrokerCommit", "GuardReentry = FALSE", "NoOverlappingAdmissions", None),
    ("active entitlement scope", "BrokerEntitlement", "PreserveScope = FALSE\n          CheckReplayScope = TRUE", "ActiveClaimKeepsScope", None),
    ("replayed entitlement scope", "BrokerEntitlement", "PreserveScope = TRUE\n          CheckReplayScope = FALSE", "ReplayRejectsMismatch", None),
    ("unused evidence", "BrokerBudget", "Requests = {1, 2}", "ReleaseNeedsEvidence", (
        'phase[r] \\in {"held", "uncertain"} /\\ ~claimed[r] /\\ unusedEvidence[r]',
        'phase[r] \\in {"held", "uncertain"} /\\ ~claimed[r]')),
    ("final evidence", "BrokerBudget", "Requests = {1, 2}", "SettlementNeedsEvidence", (
        'phase[r] \\in {"held", "uncertain"} /\\ evidence[r]',
        'phase[r] \\in {"held", "uncertain"}')),
    ("signed settlement", "BrokerFence", None, "SettledRequiresClaimAndProofs", (
        '/\\ phase \\in {"held", "uncertain"} /\\ claimed /\\ Valid(candidate)',
        '/\\ phase \\in {"held", "uncertain"} /\\ claimed')),
    ("claimed release", "BrokerFence", None, "ClaimedFundsRemainHeld", (
        '/\\ phase \\in {"held", "uncertain"} /\\ ~claimed\n           /\\ phase\' = "released"',
        '/\\ phase \\in {"held", "uncertain"}\n           /\\ phase\' = "released"')),
]

with tempfile.TemporaryDirectory(prefix="hobo-broker-model-mutants-") as directory:
    scratch = Path(directory)
    for label, name, constants, invariant, mutation in cases:
        model = (models / f"{name}.tla").read_text()
        if mutation:
            before, after = mutation
            if model.count(before) != 1:
                raise RuntimeError(f"{label}: mutation site is not unique")
            model = model.replace(before, after, 1)
        (scratch / f"{name}.tla").write_text(model)
        config = (f"CONSTANTS {constants}\n" if constants else "")
        config += f"SPECIFICATION Spec\nINVARIANT {invariant}\n"
        (scratch / "Mutant.cfg").write_text(config)
        result = subprocess.run(
            ["java", "-XX:+UseParallelGC", "-cp", str(jar), "tlc2.TLC", "-workers", "1", "-config", "Mutant.cfg", f"{name}.tla"],
            cwd=scratch, text=True, capture_output=True, check=False,
        )
        output = result.stdout + result.stderr
        if result.returncode == 0 or f"Invariant {invariant} is violated" not in output:
            raise RuntimeError(f"{label}: expected {invariant} counterexample\n{output}")
        print(f"Expected counterexample: {label} / {invariant}", flush=True)
