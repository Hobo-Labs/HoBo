# HOBO-179 Feature Flag Governance Proof

This proof connects the M2 feature-flag governance slice to:

- [contracts-policy-flags.md](../../contracts-policy-flags.md#plan-29)
- [ADR-0044](../../adr/02-identity-security.md#adr-0044)

Executable artifact:

- [`src/draft/technical-proofs/feature-flag-governance-contract`](../../../../src/draft/technical-proofs/feature-flag-governance-contract)

Acceptance evidence:

- A prod kill-switch flip returns `require-approval` and emits
  `policy.Decided`.
- A risky prod percentage bump returns `require-approval` and carries a durable
  `feature-flag.auto-revert-on-slo-burn` obligation.
- A low-risk dev flip is ungated: no approval and no obligation.
- Every gated flip in the proof emits `policy.Decided`.
- A simulated `slo.Burned` signal fires the auto-revert obligation as
  `flag.RevertRequested`.
- A caller claiming low risk cannot avoid prod kill-switch gating.
- A direct prod gate bypass attempt is denied.
- A prod flip during evaluator outage fails closed.

Scope boundary:

- No OpenFeature port, built-in flag store, evaluator, flag type system,
  reactive re-evaluation, stale-flag cleanup, Harness transport, or SLO signal
  source implementation.
- This proof owns only the governance-side contract consumed by the flag
  runtime.
