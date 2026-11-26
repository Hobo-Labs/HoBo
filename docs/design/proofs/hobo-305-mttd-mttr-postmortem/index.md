# HOBO-305 MTTD/MTTR Postmortem Proof

This proof pins the SRE process-SLO and learning-loop slice from
[Plan 40](../../operators-sre.md#plan-40), the SLO-as-code / error-budget gate
from [Plan 05](../../reliability-observability-cost.md#plan-05), the policy
`can-deploy` dimension from [Plan 29](../../contracts-policy-flags.md#plan-29),
and the incident-management decision in
[ADR-0058](../../adr/03-data-plane.md#adr-0058).

Executable proof:

- package: `src/draft/technical-proofs/sre-mttd-mttr-postmortem-contract`
- test command: `npm.cmd --prefix src\draft\technical-proofs\sre-mttd-mttr-postmortem-contract test`

Acceptance coverage:

- `sre.mttd` and `sre.mttr` are emitted as OpenSLO-compatible duration SLOs.
- an incident that exceeds the MTTR target emits `incident.SLABreached`.
- MTTR overrun consumes error-budget minutes and creates an auditable
  `can-deploy` freeze for risky deploys.
- a resolved incident generates `incident.PostmortemFiled` from the incident
  replay log.
- failed remediation creates a permanent incident replay regression test.

Adversarial coverage:

- a risky deploy is blocked for `sre.mttr` budget burn with an explicit audit
  reason and breach event id.
- identical replay logs generate byte-identical postmortem markdown and content
  hashes even if caller-supplied privileged state differs.

Scope boundary:

- eval/training promotion is consumed as `gated-eval-required` candidate
  artifacts only.
- status-page publishing remains out of scope.
- live alert, incident, remediation, and policy services are consumed through
  event streams rather than implemented here.
