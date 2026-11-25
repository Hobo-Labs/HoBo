---
type: Reference
title: "Launch E2E Persona Matrix"
description: "Source issue: HOBO-500."
tags: [hobo, design]
---

# Launch E2E Persona Matrix

Source issue: HOBO-500.

Executable proof lives in
[`src/draft/exp-proofs/dx/v1-e2e-persona-matrix-contract`](../../src/draft/exp-proofs/dx/v1-e2e-persona-matrix-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-500-launch-e2e-persona-matrix`](./proofs/hobo-500-launch-e2e-persona-matrix/README.md).

## M0 Acceptance Record

The v1 launch e2e matrix defines the small set of persona journeys that decide beta and GA
readiness. It is not a full browser/device lab and not the e2e harness implementation. It records
the journey owner, environment, fixture data, mocked/live boundary, expected evidence, and
pass/fail threshold for the launch claim.

## Persona Journeys

| Persona | Journey | Environment | Fixture data | Mocked boundary | Live boundary | Expected evidence | Pass threshold | Fail threshold |
|---|---|---|---|---|---|---|---|---|
| App developer | First deploy | Release-candidate workspace with local CLI and mocked provider apply | Hello Bindle manifest, pre-launch outcome baseline, safe-test fixture | Cloud provider apply, billing write, notification delivery | CLI transcript, contract validator, local browser smoke | Safe-test result pack, plan/diff baseline, launch status snapshot | Collect, preview, approve, and reach simulated launch status with no launch blockers | Missing plan/diff, unsafe approval, unknown fixture, or unresolved launch blocker |
| Platform engineer | Policy review | Staged Yard fixture with policy, quota, and cost gates | Yard policy pack, cost-cap baseline, topology diff | Provider quota API, live infrastructure mutation | Policy decision fixture, topology contract, cost guardrail evaluation | Policy decision, cost guardrail, topology summary | Risky actions are blocked or routed to approval with cost and topology evidence | Policy denial, quota breach, or cost-cap ambiguity is hidden from launch decision |
| Admin | Member and entitlement review | Tenant admin fixture with RBAC, entitlement, and audit boundaries | Workspace members, role assignments, entitlement state | Identity provider write, payment processor | RBAC evaluator fixture, audit event validator | RBAC decision, entitlement snapshot, admin audit record | Admin can verify who can launch, approve, pause, or inspect before beta claim | Privilege, entitlement, or audit gaps are not visible to the admin |
| Support/operator | Failure recovery | Release support fixture with failed deploy, rollback, and escalation states | Failed deployment event, rollback expectation, support runbook | Customer support system, provider incident API | Failure classifier, support export contract, rollback decision record | Failure classification, support handoff, rollback decision | Support can explain status, next owner, rollback path, and customer-safe message | Failure route is unknown, unactionable, or missing customer-safe evidence |
| Security reviewer | Launch claim review | Security verification fixture with secret, provenance, and access checks | Capability manifest, provenance attestation, secretless config | External vulnerability scanner, cloud IAM write | Secret scanner fixture, provenance verifier, capability policy validator | Secretless proof, provenance check, capability-scope decision | No stored secret, unscoped capability, or unproven artifact reaches launch claim | Security evidence is missing, stale, or contradicted by fixture output |
| Customer/buyer | Value proof review | Moderated beta fixture with buyer-safe outcome and value proof view | Plain-language outcome, success signal, value proof summary | Live ROI analytics, customer-success workflow | Outcome baseline contract, value proof copy review, known-limitation register | Outcome baseline, value proof summary, known-limitation link | Buyer can see what was tested, what value was proven, and what remains limited | Launch copy implies untested value, unsupported compatibility, or hidden limitation |

## Flake Policy

- One retry is allowed before the owner must classify the journey as a flake.
- Repeated failure routes to a release-blocker candidate or an explicit follow-up, not a silent
  pass.
- A flake record must preserve the raw run log, fixture version, and owner decision.
- A launch-blocking journey stays blocking until the owner accepts either a rerun or an approved
  substitute evidence record.

## Manual Evidence Fallback

Manual evidence is allowed only for a non-blocking environment or lab gap when the owning release
reviewer accepts substitute evidence. The fallback record must name the reason, evidence link, and
approver. It cannot override launch blockers, security denials, or unsupported compatibility claims.

## Scope In

- Define the v1 beta/GA persona journey matrix.
- Name environment, fixture data, mocked/live boundary, expected evidence, and pass/fail threshold
  per journey.
- Define the flake policy and manual evidence fallback rules.
- Feed the release notes compatibility section with `e2e-persona-thresholds` evidence.

## Scope Out And Non-Goals

- No full e2e harness implementation.
- No live provider execution.
- No broad browser/device lab.
- No final beta or GA release decision in this issue.

## Related Records

- [outcome-activation-rail.md](./outcome-activation-rail.md) defines the activation path that these
  journeys exercise.
- [pre-launch-outcome-contract.md](./pre-launch-outcome-contract.md) defines the outcome baseline
  and safe-test evidence these journeys consume.
- [release-notes-upgrade-guide.md](./release-notes-upgrade-guide.md) consumes the e2e thresholds
  before writing compatibility claims.
