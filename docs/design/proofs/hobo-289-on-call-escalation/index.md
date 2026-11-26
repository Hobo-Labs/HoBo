# HOBO-289 On-call Escalation Proof

This proof pins the on-call escalation obligation from
[Plan 40](../../operators-sre.md#plan-40), the policy obligation model from
[Plan 29](../../contracts-policy-flags.md#plan-29), and the `hobo:notify`
receiver boundary from [ADR-0059](../../adr/03-data-plane.md#adr-0059).

Executable proof:

- package: `src/draft/technical-proofs/on-call-escalation-contract`
- test command: `npm.cmd --prefix src\draft\technical-proofs\on-call-escalation-contract test`

Acceptance coverage:

- SEV1 `incident.Opened` creates an on-call acknowledgement deadline obligation.
- the A2H package is sent through `notification.Requested` on `hobo:notify` to
  the primary on-call receiver.
- missed acknowledgement deadlines escalate to the next receiver and emit
  `incident.SLABreached`.
- human decisions are recorded as `policy.ObligationSatisfied` and replay into
  satisfied state.

Adversarial coverage:

- `requiresHuman` money-touching signals enter A2H directly without proposing or
  applying an auto-fix.
- missed deadlines remain open for escalation and never silently auto-resolve.

Scope boundary:

- rotation calendar selection is out of scope.
- PagerDuty, OpsGenie, and Slack are named receiver adapter stubs only.
- vendor-specific notification behavior is not implemented.
