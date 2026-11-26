# HOBO-280 SRE Decision Tree Proof

This proof pins the SRE decision tree contract from
[Plan 40](../../operators-sre.md#plan-40) and the policy gate model from
[Plan 29](../../contracts-policy-flags.md#plan-29).

Executable proof:

- package: `src/draft/technical-proofs/sre-decision-tree-contract`
- test command: `npm.cmd --prefix src\draft\technical-proofs\sre-decision-tree-contract test`

Acceptance coverage:

- `provider-degraded` with low-risk, non-prod, conformance-green context routes
  to `auto-fix` with `policy.Decided(effect=allow)`.
- prod `compat.GateFailed` routes to `propose` with
  `policy.Decided(effect=require-approval)`.
- unclassifiable SEV1 routes to A2H escalation with `crew.HandoffRequested`.
- `requiresHuman` signals short-circuit to A2H escalation with
  `crew.HandoffRequested`.
- each decision records `crew.ActionProposed`, `incident.RemediationProposed`,
  policy decision id, classification evidence, and diagnosis evidence for
  replay.

Adversarial coverage:

- low-risk production signals are forced out of auto-fix by the environment
  gate.
- non-green conformance state is forced out of auto-fix by the policy gate.

Scope boundary:

- this proof stops at decision/proposal/handoff facts.
- live-fix apply, canary execution, runbook execution, and on-call paging are
  separate slices.
