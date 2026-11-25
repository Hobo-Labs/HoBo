# HOBO-298 Chaos Experiment Orchestration Proof

This proof pins the chaos verification tier from
[ADR-0047](../../adr/02-identity-security.md#adr-0047), the lane isolation rules from
[ADR-0076](../../adr/02-identity-security.md#adr-0076), and the SRE operator surface from
[Plan 40](../../operators-sre.md#plan-40).

Executable proof:

- package: `src/draft/technical-proofs/chaos-experiment-orchestration-contract`
- test command: `npm.cmd --prefix src\draft\technical-proofs\chaos-experiment-orchestration-contract test`

Acceptance coverage:

- a policy-budgeted prod experiment injects one bounded fault and aborts on a steady-state breach.
- a failed experiment records a replayable regression-test command.
- prod chaos without a policy budget is denied before any fault is injected.

Adversarial coverage:

- a containable experiment that declares a baseline lease is denied shared-lane admission and routed
  to an ephemeral Camp clone.
- an abort-condition failure hard-stops the experiment instead of continuing to fault.

Scope boundary:

- external chaos engines remain adapter work behind the port.
- dashboard and red-team workflows stay out of this branch.
