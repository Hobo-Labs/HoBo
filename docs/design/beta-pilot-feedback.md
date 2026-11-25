---
type: Reference
title: "Beta Pilot Feedback Contract"
description: "HOBO-404 defines the M0 private-beta program contract: who can be a pilot, what"
tags: [hobo, design]
---

# Beta Pilot Feedback Contract

HOBO-404 defines the M0 private-beta program contract: who can be a pilot, what
feedback must capture, where findings route, and when beta evidence can support a
release-candidate decision.

## Goal

Private beta feedback must become comparable launch evidence, not ad hoc notes. The
contract links each feedback item to a persona, environment, workflow, severity,
evidence, and customer impact so release triage can decide whether it is a blocker,
known limitation, support gap, product UX gap, docs gap, or capability follow-up.

## Cohort Criteria

| Criterion | Required evidence | Owner |
|---|---|---|
| Target persona fit | Pilot maps to app developer, platform engineer, support/operator, security reviewer, admin, or buyer workflow. | Beta program owner |
| Workflow readiness | Fixture, environment, rollback/support posture, and expected evidence are defined before pilot exposure. | Workflow owner |
| Support capacity | First responder, escalation owner, and support window are available. | Support lead |
| Feedback consent | Pilot accepts structured feedback capture and customer-impact classification. | Beta program owner |
| Exclusion rules | Unsupported jurisdictions, regulated data without approval, and workflows lacking rollback/support evidence are excluded. | Release owner |

## Feedback Intake

Every beta feedback item must include:

- persona;
- environment;
- workflow;
- severity;
- evidence;
- customer impact.

Severity values are `blocker`, `high-risk-non-blocker`, `support-request`,
`usability`, `docs-gap`, `capability-gap`, and `launch-note`.

## Triage Routes

| Destination | Use when | Owner |
|---|---|---|
| Cutline | Go/no-go risk, open blocker, exception request, or launch readiness decision. | V1 Release Program & Cutline |
| Support | Support path, escalation, severity communication, or first-week coverage gap. | V1 Launch Support Desk & Escalation |
| Product UX | Onboarding, dashboard, plan/diff, or activation usability problem. | Workspace & Onboarding UX |
| Docs | Release note, upgrade guide, known limitation, or troubleshooting gap. | V1 Release Notes & Upgrade Guide |
| Capability project | Provider, runtime, identity, billing, marketplace, or other capability gap. | Owning capability project |

## Release Candidate Exit

Beta evidence can support release-candidate promotion only when:

- no blocker-severity beta feedback remains open;
- app developer, platform engineer, and support/operator workflows have evidence or accepted limitations;
- required feedback evidence is attached or explicitly accepted as a limitation;
- unresolved high-risk non-blockers have owner-approved launch notes or exceptions.

## Dogfood/Alpha Evidence Gate

HOBO-456 records the M1 dogfood/alpha gate for this project. The gate accepts the
M0 intake contract only when it has a pilot cohort snapshot, workflow evidence
matrix, feedback intake ledger, triage routing snapshot, blocker/risk register,
cross-project cutline map, follow-up gap register, and initiative risk delta.

Every blocker or risk must route to Cutline, Support, Product UX, Docs, or an
owning capability project. Follow-up issues are created only for missing
accepted evidence, owner blockers, or scope changes. If the evidence changes
launch risk, the parent HoBo v1 Release Readiness initiative must get a status
update; a no-risk-delta gate records why no update is required.
## M3 Release Candidate Evidence

HOBO-470 records the M3 release-candidate evidence gate. The gate lists owner-mapped evidence,
blockers, accepted risks, cross-project cutline dependencies, and follow-up work only where evidence
is missing. It keeps private-beta evidence separate from GA readiness: GA claims remain blocked until
the M4 handoff issue records GA evidence.

Executable proof lives in
[`../../src/draft/exp-proofs/cx/beta-pilot-release-candidate-evidence-contract`](../../src/draft/exp-proofs/cx/beta-pilot-release-candidate-evidence-contract/README.md).

## M4 GA Handoff Evidence

HOBO-477 records the M4 GA handoff evidence gate. The gate maps feedback intake, private-beta
evidence, release-candidate evidence, support routing, release-cutline handoff, and GA feedback
summary evidence to owner projects. It records cleared blockers and accepted risks, reflects
documentation, productization, operations-readiness, support, and release-cutline dependencies, and
allows follow-up execution only for missing evidence.

Parent HoBo v1 Release Readiness status is updated because this gate clears the M3 GA-handoff gap
and reduces launch risk. The gate does not onboard beta customers, expand the pilot cohort, build a
feedback portal, implement support tooling, resolve launch blockers, or publish GA readiness claims
from beta evidence alone.

Executable proof lives in
[`../../src/draft/exp-proofs/cx/beta-pilot-ga-handoff-evidence-contract`](../../src/draft/exp-proofs/cx/beta-pilot-ga-handoff-evidence-contract/README.md).

## Scope Boundaries

This record does not onboard beta customers, implement support tooling, create
general product feedback infrastructure, or resolve blockers surfaced by beta
feedback. It only defines the intake and triage contract those later issues use.

## Proof

M0 executable proof lives in
[`../../src/draft/exp-proofs/cx/beta-pilot-feedback-contract`](../../src/draft/exp-proofs/cx/beta-pilot-feedback-contract/README.md).
M1 dogfood/alpha evidence proof lives in
[`../../src/draft/exp-proofs/cx/beta-pilot-dogfood-alpha-evidence-contract`](../../src/draft/exp-proofs/cx/beta-pilot-dogfood-alpha-evidence-contract/README.md).

M2 private-beta evidence proof lives in
[`../../src/draft/exp-proofs/cx/v1-beta-pilot-private-beta-evidence`](../../src/draft/exp-proofs/cx/v1-beta-pilot-private-beta-evidence/README.md).

M4 GA handoff evidence proof lives in
[`../../src/draft/exp-proofs/cx/beta-pilot-ga-handoff-evidence-contract`](../../src/draft/exp-proofs/cx/beta-pilot-ga-handoff-evidence-contract/README.md).
