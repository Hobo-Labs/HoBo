# HOBO-216 SRE Drift Remediation Journey Proof

This proof pins the SRE drift-to-remediation user story from
[Plan 40](../../operators-sre.md#plan-40), the drift/logs/observability surface
from [Plan 05](../../reliability-observability-cost.md#plan-05), the
inspect/logs/drift CLI surface from [Plan 07](../../developer-experience.md#plan-07),
the incident-management decision in
[ADR-0058](../../adr/03-data-plane.md#adr-0058), and autonomous-action safety
rails in [ADR-0094](../../adr/02-identity-security.md#adr-0094).

Executable proof:

- package: `src/draft/exp-proofs/dx/sre-drift-remediation-journey-contract`
- test command: `npm.cmd --prefix src\draft\exp-proofs\sre-drift-remediation-journey-contract test`

Acceptance coverage:

- prod drift is surfaced through `hobo inspect`, `hobo drift`, and `hobo logs`.
- diagnosis uses read-only projection queries before proposing a fix.
- production remediation waits on an approval obligation and applies only after
  a separate human approval.
- approved remediation is followed by `hobo up`, and a second `hobo up` noops.
- low-risk reversible drift auto-applies through a rollback-capable canary.
- the incident is reconstructible from one replayable event stream.

Adversarial coverage:

- unclassifiable incident signals escalate to on-call with a deadline.
- RBAC and spend-cap violations are denied and audited.
- failed reconcile gates emit no partial provision/apply effects.
- adopted provider state is not healed backward.
- self-approval by the proposing SRE agent is rejected.

Scope boundary:

- crew/runbook engines, live CLI/MCP servers, dashboard approval UI,
  drift-heal internals, SLO projections, and chaos experiments remain outside
  this proof.
