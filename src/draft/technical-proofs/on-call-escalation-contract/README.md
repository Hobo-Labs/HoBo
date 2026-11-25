# On-call Escalation Contract POC

Independent POC for HOBO-289.

This package extends the SRE A2H lane with an on-call acknowledgement deadline
as a durable policy obligation. It emits the obligation, sends the typed A2H
handoff package over `hobo:notify`, requests human handoff, escalates missed
deadlines up a stub receiver ladder, and records human decisions as replayable
facts.

Proven behavior:

- a SEV1 incident pages the primary on-call receiver through `hobo:notify`.
- the page creates `policy.ObligationCreated` with an acknowledgement deadline.
- an unacked deadline emits `policy.ObligationEscalated`,
  `notification.Requested`, `crew.HandoffRequested`, and
  `incident.SLABreached`.
- the second handoff is causally chained to the first, avoiding a crew handoff
  race.
- `apply-fix`, `re-bless`, and `abort` decisions satisfy the obligation as
  event-sourced facts.
- `requiresHuman` money-touching signals enter A2H without `crew.ActionProposed`
  or `incident.RemediationProposed`.

Scope boundary:

- no rotation-calendar machinery is implemented.
- PagerDuty, OpsGenie, and Slack are adapter stubs only.
- the package does not apply fixes, re-bless golden suites, or abort live
  operations; it records the chosen decision.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\on-call-escalation-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for On Call Escalation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
