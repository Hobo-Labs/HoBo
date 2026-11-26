# HOBO-360 Human Approval Generation Gate Proof

This proof hardens the generation policy gate so high-risk/prod/high-trust
generation cannot certify or promote without a meaningful human decision.

Design refs:

- [generated-stack.md](../../generated-stack.md#plan-23)
- [ai-native-agent-auth.md](../../ai-native-agent-auth.md#plan-06)
- [contracts-policy-flags.md](../../contracts-policy-flags.md#plan-29)
- [ADR-0074](../../adr/02-identity-security.md#adr-0074)

Executable artifact:

- [`src/draft/technical-proofs/human-approval-generation-gate-contract`](../../../../src/draft/technical-proofs/human-approval-generation-gate-contract)

Acceptance evidence:

- Prod/high-risk generation emits `policy.Decided`,
  `policy.ObligationCreated`, and `gen.ApprovalHookCreated` without
  `gen.Certified`.
- Approval records the shown provenance, conformance, and safety reports before
  emitting `gen.Certified`.
- A mandatory deny-ceiling keeps the prod approval gate on even when a lower
  policy pack attempts automatic approval.
- Denial is event-sourced and never emits `gen.Certified`.
- Agent self-approval, auto-resolved empty approval, caller risk downgrades, and
  unknown risk all fail closed to a human gate.

Scope boundary:

- No dashboard, Slack, or hook transport implementation.
- No policy-engine implementation beyond the gate contract inputs.
- No Registry publish, SLSA signing, conformance execution, or generation
  runtime. Those are consumed as report references.
