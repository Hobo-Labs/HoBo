# HOBO-353 Experiment Statistical Analysis Proof

This proof connects the OpenExperiment statistical-analysis surface to:

- [contracts-policy-flags.md](../../contracts-policy-flags.md#plan-29)
- [reliability-observability-cost.md](../../reliability-observability-cost.md#plan-05)
- [ADR-0083](../../adr/02-identity-security.md#adr-0083)

Executable artifact:

- [`src/draft/technical-proofs/experiment-statistical-analysis-contract`](../../../../src/draft/technical-proofs/experiment-statistical-analysis-contract)

Acceptance evidence:

- Fixed exposures and metrics analyze as a pure replayable function with a
  deterministic `experiment.Concluded` event at the pinned sequence.
- A clearly winning variant concludes `winner` and maps to the existing
  `hobo:experiment` `promote` verdict with a confidence interval.
- An underpowered experiment concludes `inconclusive`, never a false winner.
- A guardrail regression with a confidence interval beyond the allowed
  regression flips a would-be primary-metric winner to `do-not-ship` /
  `rollback`.
- Sampled exposure counts are scaled into population estimates rather than read
  as full traffic.
- A zero-exposure experiment concludes `inconclusive`, not divide-by-zero.

Adversarial evidence:

- A bounded metric with an extreme outlier is clamped before aggregation, so one
  subject cannot flip the verdict.
- A sampled exposure without a valid sample rate fails closed.

Scope boundary:

- Assignment and exposure collection remain in HOBO-349.
- Peeking, p-hacking, and multiple-comparison guardrails are hardened by
  [HOBO-375](../hobo-375-experiment-guardrails/index.md).
- Provider adapters and ML/training-engine integration remain out of scope.
