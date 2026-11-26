# HOBO-284 Gated Remediation Proof

This proof pins the SRE write path from
[Plan 40](../../operators-sre.md#plan-40), the live-fix canary/rollback
machinery from [Plan 05](../../reliability-observability-cost.md#plan-05),
the policy gate from [Plan 29](../../contracts-policy-flags.md#plan-29), and
the autonomous safety rails from
[ADR-0094](../../adr/02-identity-security.md#adr-0094).

Executable proof:

- package: `src/draft/technical-proofs/gated-autonomous-remediation-contract`
- test command: `npm.cmd --prefix src\draft\technical-proofs\gated-autonomous-remediation-contract test`

Acceptance coverage:

- low-risk remediation is policy-allowed, records `crew.ActionProposed`, then
  applies through a live-fix canary.
- injected SLO/Golden regression rolls the canary back and records
  `incident.RemediationFailed`.
- production remediation waits behind `policy.ObligationCreated` until a human
  approval satisfies the obligation.
- approved production remediation emits a fresh `policy.Decided(effect=allow)`
  before `crew.ActionApplied`.
- replay rebuilds the remediation state from `crew.*`, `policy.*`,
  `incident.*`, and `rollout.*` facts.

Adversarial coverage:

- a rolled-back canary installs a cooldown loop guard and escalates through
  `crew.HandoffRequested` instead of immediately re-proposing the same fix.
- `crew.ActionApplied` without a matching allow policy decision fails replay.

Scope boundary:

- live-fix candidate generation and validation internals are out of scope.
- SRE diagnosis/classification is consumed from HOBO-280 rather than rebuilt.
- approval UI and on-call paging are separate slices.
