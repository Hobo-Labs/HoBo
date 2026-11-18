---
name: verify-replay-harness
description: Verify cleanup of temporary clock and random overrides when changing the deterministic replay equivalence harness.
---

# Replay harness cleanup

**Property:** Once the synchronous replay check finishes or throws, every installed clock or random override whose original descriptor can be restored is restored; failure to restore random does not prevent the clock restoration attempt.

**Why:** A failed verification must not silently change the clock or randomness seen by later application code or tests.

**Review baseline:** `1c87d75e1c9fc7e762f5b64a1fb86b17f13b36eb`.

## Covered code and checks

- `packages/runtime/src/replay/equivalence.ts`, especially `withAmbientNondeterminism`, installs and restores the temporary globals used by `runFold` and `assertReplayEqualsLive`.
- `packages/runtime/test/replay/equivalence-cleanup.test.ts` checks nonwritable setup, accessor refusal, callback exceptions and changed descriptors. Seed 614609 generates 80 setup and callback-failure combinations. A child process deliberately makes the random descriptor unrestorable and checks the independent clock cleanup without permanently modifying the test process.
- `packages/runtime/test/replay/equivalence.test.ts` exercises the existing deterministic-fold and divergence checks.

From the repository root with dependencies installed, run:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-replay-harness
python3 .agents/skills/verify-replay-harness/mutations/full.py
```

The runner checks the pinned TLC 1.7.4 jar and uses Z3 4.15.4. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to existing installations for offline runs. The mutation command checks five broken scratch implementations with the full skill and reruns the restored code. Java 11+, Python, Node, and the repository dependencies are required.

## Model and evidence

`ReplayHarnessCleanup` explores 118 states and 234 steps for writable or nonwritable clock and random properties, a returning or throwing callback, changed descriptors, and independently successful or failed restoration. It checks that each restorable global is restored at exit, including after setup fails and after restoration of the other global fails. Its six-state projection has seven arrows and hides 118 same-state steps. `/statechart` can render the model and explain any counterexample.

```mermaid
stateDiagram-v2
  s0: Replay check requested
  s1: Overrides restored when possible
  s2: Clock override installed
  s3: Clock restoration pending
  s4: Both overrides installed
  s5: Fold finished or threw
  [*] --> s0
  s0 --> s1: install clock or stop
  s0 --> s2: install clock or stop
  s2 --> s3: install random or clean up
  s2 --> s4: install random or clean up
  s3 --> s1: restore clock
  s4 --> s5: run fold
  s5 --> s3: restore random
```

Without setup cleanup, the shortest counterexample installs the clock override, fails to install random, and exits with the override still active. Without the independent cleanup, a failed random restoration skips clock restoration. Four weakened TLC checks and four weakened Z3 assumptions produce counterexamples. Z3 proves the abstract implications from a completed cleanup attempt and a restorable descriptor to a restored value; it does not verify the TypeScript implementation.

The model assumes ordinary data-property intrinsics, indivisible installation and restoration steps, and truthful classifications of whether each descriptor can be restored. A callback that makes a property nonconfigurable can prevent its restoration; the other cleanup is still attempted. The harness temporarily changes process-global functions while synchronous callbacks run. It tests only selected ambient nondeterminism and does not detect every source, such as `new Date()` or external state. The model does not establish implementation refinement, callback purity, other workers' behavior or liveness.

## Keep in sync

Inspect changes to the covered code and tests since the baseline, including uncommitted changes. Replay counterexamples against the real code, rerun both commands and the broken variants, and advance the baseline only after the model and implementation agree. Use `/maintain-formal-verification-skill` for that review.
