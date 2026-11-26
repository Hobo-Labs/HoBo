# HOBO-219 DevOps self-host Yard journey proof

This proof backs the DevOps "self-host = hosted" walkthrough in
[walkthrough Part 5](../../walkthrough.md#part-5--devops-run-the-control-plane-and-the-ci-fabric)
and the lifecycle CLI semantics in
[developer-experience](../../developer-experience.md#command-surface).
It composes the self-host bootstrap ordering pinned by
[ADR-0092](../../adr/01-architecture-core.md#adr-0092).

Executable proof lives in the repo-standard draft path:

- [`src/draft/exp-proofs/dx/devops-self-host-yard-journey-contract`](../../../../src/draft/exp-proofs/dx/devops-self-host-yard-journey-contract)

## Proven boundaries

- `hobo up ./platform --seed` then `hobo up ./platform --camp host-azure`
  yields a reachable self-hosted Yard after single-use seed credential handoff.
- The real Yard's Identity broker replaces the seed credential; reuse attempts
  are denied and do not emit a second seed use.
- `hobo up ./platform --restore <log>` rebuilds from a last-good event log and
  refuses corrupt or partial restore logs.
- Re-running `hobo up ./platform` upgrades through the same gate and rolls back
  on gate failure.
- Control-plane state is never modeled as living on the operator laptop after
  the disposable seed phase.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\devops-self-host-yard-journey-contract test
```
