# HOBO-358 Training Data Poisoning Guard Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05),
[PLAN-23](../../generated-stack.md#plan-23),
[ADR-0025](../../adr/03-data-plane.md#adr-0025), and
[ADR-0099](../../adr/03-data-plane.md#adr-0099).

Executable artifact:

- [`src/draft/technical-proofs/training-data-poisoning-guard-contract`](../../../../src/draft/technical-proofs/training-data-poisoning-guard-contract)

Acceptance evidence:

- Poisoned high-reward trajectories cannot promote a contract-violating or
  rubric-gaming candidate; the contract backstop rejects it.
- Poisoned samples are quarantined with auditable
  `training.TrajectoryQuarantined` events and concrete reasons.
- Candidate influence replay reconstructs which trusted trajectory ids and
  hashes affected a candidate, plus which trajectories were quarantined.
- Promotion only happens after contract pass, minimum independent trusted
  sources, shadow evidence floor, and trusted reward floor.

Adversarial evidence:

- Label-flip poisoning is detected and quarantined.
- Reward-inflation poisoning is detected and quarantined.
- Gradual-drift poisoning is detected and quarantined before promotion.
- A Sybil burst with identical source fingerprints cannot clear the independent
  sample floor.
- An under-shadowed candidate cannot promote even when trusted reward and
  independent sources are otherwise sufficient.

Scope boundary:

- No optimizer implementation.
- No model-training runtime.
- No shadow router, champion swap, or promotion applier.
- No provider-backed labeling or reward service.
