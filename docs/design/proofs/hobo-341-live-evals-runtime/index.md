# HOBO-341 Live Evals Runtime Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05),
[PLAN-23](../../generated-stack.md#plan-23), and
[ADR-0025](../../adr/03-data-plane.md#adr-0025).

Executable artifact:

- [`src/draft/technical-proofs/live-evals-runtime-contract`](../../../../src/draft/technical-proofs/live-evals-runtime-contract)

Acceptance evidence:

- Champion live traffic emits `eval.Ran` and writes rewards onto trajectory ids.
- A regressing challenger emits `eval.GateFailed` and remains in shadow.
- A regressing champion raises `eval.DriftDetected` with a proposed live-fix handoff, not an applied fix.
- Gate movement is held until both the sample floor and shadow-traffic floor are satisfied.

Adversarial evidence:

- Under-sampled evals cannot move a promotion gate.
- Under-shadowed challengers cannot pass or fail the promotion gate.
- Conflicting labels for one trajectory quarantine the batch and write no reward.

Scope boundary:

- No optimizer implementation.
- No shadow router, champion swap, or promotion applier.
- No live-fix applier; the POC only emits the proposed handoff signal.
