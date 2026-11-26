---
type: Reference
title: "Customer Onboarding Scope, Script, and Success Criteria"
description: "Source issues: HOBO-449 and HOBO-487."
tags: [hobo, design]
---

# Customer Onboarding Scope, Script, and Success Criteria

Source issues: HOBO-449 and HOBO-487.

Scope proof lives in
[`src/draft/exp-proofs/cx/customer-onboarding-scope-acceptance`](../../src/draft/exp-proofs/cx/customer-onboarding-scope-acceptance/README.md),
with branch evidence summarized in
[`proofs/hobo-449-customer-onboarding-scope`](./proofs/hobo-449-customer-onboarding-scope/README.md).

Script proof lives in
[`src/draft/exp-proofs/cx/customer-onboarding-script-contract`](../../src/draft/exp-proofs/cx/customer-onboarding-script-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-487-customer-onboarding-script`](./proofs/hobo-487-customer-onboarding-script/README.md).

## M0 Scope Acceptance Record

Customer Onboarding owns the v1 pilot-customer entry path from qualification through workspace
entry, outcome baseline, safe proof, first deploy readiness, support handoff, and feedback routing.
This M0 record defines what later M1 design and contract issues must prove before HoBo claims a
first-customer onboarding path is ready.

## M0 User And Business Goal

HoBo needs a customer onboarding path that makes first-customer readiness explicit without hiding
customer-success operations, support tooling, live customer data, or marketing work inside a product
scope issue. A customer, app developer, support operator, and release owner should all be able to
see the next step, owner, accepted limitation, and proof source for the onboarding stage.

## M0 Primary Personas

| Persona | Need |
|---|---|
| Pilot customer admin | Needs prerequisites, accepted limitations, approval owners, and customer-safe proof before allowing pilot use. |
| First-time app developer | Needs a scripted path from workspace entry to safe-test or first deploy evidence without hidden platform setup. |
| Customer success lead | Needs success criteria, outcome evidence, feedback routing, and handoff owners without a CRM implementation. |
| Support operator | Needs stalled-state, next-action, owner, and evidence fields to route onboarding failures safely. |
| Security reviewer | Needs customer-data, consent, redaction, and unsupported-state boundaries before pilot evidence is shared. |

## M0 Scope In

- Define the accepted customer onboarding stage model.
- Name entry and exit evidence for qualification, profile capture, workspace entry, outcome
  baseline, safe proof, support handoff, and feedback intake.
- Map service, UX, security, and support boundaries.
- Map owning dependencies to Workspace & Onboarding UX, Persona Operating Profile, Pre-Launch
  Outcome Contract, Beta Pilot Feedback, Launch Support Desk, and Release Cutline.
- List M1 evidence required before customer onboarding scripts, support fixtures, or contract proof
  issues can fan out.
- Block M1-M4 follow-up work until this M0 scope record is accepted.

## M0 Scope Out And Non-Goals

- Do not build CRM, customer-success automation, sales workflow, marketing pages, launch-site copy,
  or sales enablement.
- Do not import live customer data, mutate production tenants, collect customer PII, or store
  customer account records.
- Do not implement dashboard, workspace onboarding UI, auth, billing, support ticketing, telemetry,
  notification, or provider deployment systems.
- Do not make live provider, production launch, or customer-ready go-live claims without accepted
  safe-test and provider evidence.
- Do not create M1-M4 implementation issues before this M0 scope record is accepted.

## Customer Onboarding Stage Model

| Stage | Owner | Evidence |
|---|---|---|
| Qualify | Customer Onboarding | Pilot-fit record with persona, environment, consent, support window, and exclusion checks. |
| Profile | Persona Operating Profile | Minimal profile fixture with risk posture, cost cap, approved systems, and do-not-do boundaries. |
| Workspace entry | Workspace & Onboarding UX | Workspace, project, and provider-readiness state with missing prerequisites marked non-green. |
| Outcome baseline | Pre-Launch Outcome Contract | Customer-visible outcome baseline with success signal, owner, failure rule, and rollback expectation. |
| Safe proof | E2E Test Matrix / Example Apps | Safe-test result pack or simulated-provider proof with mocked/live boundary labels. |
| Support handoff | V1 Launch Support Desk & Escalation | Stalled-state owner, next action, severity, customer-safe message, and evidence source. |

## M0 Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Customer Onboarding owns the stage model, success criteria, proof requirements, and follow-up gate. It does not build CRM or customer-success systems. |
| UX | Workspace & Onboarding UX owns the first-run product rail and future UI behavior. Customer Onboarding only defines inputs and handoffs. |
| Security | Security and legal/privacy owners govern consent, redaction, customer-data exclusion, and unsupported regulated-workflow routing. |
| Support | Support owns handoff language, stalled-state routing, severity mapping, and unsupported-request escalation. |

## M0 Authoritative Dependencies

- [Workspace & Onboarding UX](./workspace-onboarding-ux.md) owns the first-run product rail that
  customer onboarding consumes.
- [Persona Operating Profile](./persona-operating-profile.md) owns minimal profile fields and
  recommendation boundaries.
- [Pre-Launch Outcome Contract](./pre-launch-outcome-contract.md) owns the customer-visible
  outcome baseline and success signal.
- [Launch E2E Persona Matrix](./launch-e2e-persona-matrix.md) owns persona journey evidence
  thresholds for beta and GA readiness.
- [Beta Pilot Feedback](./beta-pilot-feedback.md) owns pilot eligibility, structured feedback, and
  blocker triage.
- [Support SLA Channels](./support-sla-channels.md) owns support channel and unsupported-request
  routing language.

## Owning Initiative Dependencies

| Owner | Consumes from Customer Onboarding | Boundary |
|---|---|---|
| Customer Onboarding | Accepted stage model, success criteria, proof requirements, and follow-up gate. | This issue defines scope and acceptance; implementation waits for later phases. |
| Workspace & Onboarding UX | Onboarding entry/exit states and missing-prerequisite presentation requirements. | Product rail and UI behavior remain outside Customer Onboarding M0. |
| Persona Operating Profile | Minimal profile facts that tune defaults and approval routes. | Broad CRM, customer-success profile, and behavioral tracking remain out of scope. |
| Pre-Launch Outcome Contract | Outcome baseline fields used to define first-customer success. | Outcome storage and post-launch comparison remain outside Customer Onboarding M0. |
| V1 Beta Pilot & Feedback Loop | Pilot fit, consent, feedback classification, and blocker routing. | Beta program operation and triage execution stay with the beta owner. |
| V1 Launch Support Desk & Escalation | Support handoff fields and unsupported request routing. | Support queues, staffing, and helpdesk integrations remain support scope. |
| V1 Release Program & Cutline | Customer onboarding gaps as readiness blockers or accepted limitations. | Release go/no-go and launch claims remain release-owner scope. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Scope record | Customer Onboarding | Design record | Goal, personas, scope, boundaries, dependencies, and follow-up gate are accepted. |
| Pilot script fixture | Customer Onboarding | Reference fixture | Each onboarding stage names entry criteria, exit criteria, owner, and evidence. |
| Success criteria register | Pre-Launch Outcome Contract | Contract test | Outcome, success signal, cost cap, approval rule, failure rule, and review date exist before customer claims. |
| Persona profile fixture | Persona Operating Profile | Policy fixture | Defaults are tuned without broad CRM or behavioral tracking data. |
| Safe-test handoff | Workspace & Onboarding UX / E2E Test Matrix | Contract test | Safe-test or simulated-provider evidence is linked before any live-provider claim. |
| Support feedback router | Beta Pilot Feedback / Launch Support Desk | Support handoff | Blocked states route to support, beta feedback, release cutline, docs, or capability owner. |

## M0 Follow-Up Gate

M1/M2/M3/M4 customer onboarding scripts, support fixtures, customer-success processes, design
records, or implementation issues must wait until this M0 scope record and executable proof are
accepted. This branch records the gate and its executable guard; it does not create follow-up
implementation issues.

## Script Acceptance Record

Customer Onboarding owns the repeatable first-customer script that customer success can use during
private beta. The script makes pilot evidence comparable across customers while keeping product
onboarding, support tooling, deploy runtime, billing, and legal approval out of scope.

## Script User And Business Goal

Private beta needs a consented, customer-safe script that gets a pilot from invite to workspace,
project choice, first accepted proof or blocker, recovery, support handoff, and feedback capture.
Release owners need the outcome to classify blockers, support gaps, docs gaps, product UX gaps, and
engineering gaps without reading private customer data.

## Script Primary Personas

| Persona | Need |
|---|---|
| Pilot customer champion | Understand the first HoBo journey, choose a sample or real project, and know when to stop for support. |
| Customer success lead | Run a repeatable script that captures comparable first-success and blocker evidence across pilots. |
| Support engineer | Receive stalled-stage, owner, safe next action, and evidence links without reading private project data. |
| Release owner | Classify pilot outcomes into cutline, docs, support, product UX, or engineering follow-up before beta or GA claims. |

## Script Scope In

- Scripted invite, preparation, workspace setup, sample-or-real project choice, first deploy proof,
  failure recovery, support handoff, and feedback capture.
- Customer-visible success criteria for time-to-first-success, blocker categories, handoff quality,
  and unresolved risk.
- Routing matrix for pilot notes into cutline, docs, Workspace & Onboarding UX, Support Workflow,
  or owning engineering project.
- Evidence and consent gate for future pilot usage without collecting live customer data in this
  proof package.

## Script Scope Out And Non-Goals

- Do not automate onboarding, build a product wizard, create a customer-success platform, create a
  support queue, or implement support tools.
- Do not capture live customer data, onboard production customers, approve billing conversion,
  provide legal approval, or publish launch claims.
- Do not provision real cloud resources, handle provider credentials, implement deploy runtime, or
  execute a real first deploy.
- Do not create M1-M4 implementation issues before this script contract is accepted.

## Script Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Customer Onboarding owns the script, pilot evidence fields, and handoff record; account, workspace, deploy, billing, and support services remain with their owning projects. |
| UX | The script references the first-run path but does not build onboarding UI, product tours, dashboards, or notification copy. |
| Security | Pilot evidence avoids secrets, provider credentials, raw customer project data, and policy bypasses; consent and unsupported-state labels are mandatory before use. |
| Support | Support receives stage, blocker category, safe next action, owner, and evidence link; support SLAs, ticket queues, and remediation remain separate. |

## Script Authoritative Dependencies

- [Workspace & Onboarding UX](./workspace-onboarding-ux.md) defines first-run activation stages,
  stalled states, and support handoff fields consumed by pilot scripts.
- [Example Apps](./example-apps.md) supplies accepted sample-app proof modes when a pilot chooses a
  sample project instead of a real project.
- [Beta Pilot Feedback](./beta-pilot-feedback.md) defines comparable feedback intake and
  release-candidate exit rules for private-beta evidence.
- [Launch Demo Golden Path](./launch-demo-golden-path.md) keeps launch demo assets separate from
  customer onboarding while reusing proof-mode language.
- [Launch Support Escalation](./launch-support-escalation.md) defines support escalation language
  that the script may hand off to without creating support tooling.
- [Launch Blocker Taxonomy](./launch-blocker-taxonomy.md) supplies blocker, high-risk non-blocker,
  launch-note, and post-GA follow-up classes for pilot outcomes.

## Script Stages

| Stage | Owner | Expected Evidence |
|---|---|---|
| Invite | Customer success lead | Pilot intake record with persona, consent, support owner, and target workflow. |
| Workspace setup | Pilot customer champion | Workspace setup note with owner, state, missing prerequisite, and safe next action. |
| Project choice | Customer success lead | Sample-or-real project decision with proof mode, data boundary, and unsupported-state note. |
| First deploy | Pilot customer champion | First deploy evidence link, refusal, or blocker category with proof mode. |
| Failure recovery | Support engineer | Recovery note with blocker category, owner, safe next action, and escalation threshold. |
| Support handoff | Support engineer | Support handoff record with severity, owner, evidence link, and customer-safe message. |
| Feedback capture | Release owner | Feedback record routed to cutline, docs, product UX, support, or engineering follow-up. |

## Success Criteria

| Criterion | Owner | Measures |
|---|---|---|
| Time to first success | Customer success lead | Elapsed time from invite acceptance to first accepted proof evidence or explicit blocker. |
| Blocker categories | Release owner | Each stop is classified as blocker, high-risk non-blocker, support gap, docs gap, product UX gap, or engineering gap. |
| Handoff quality | Support engineer | Every handoff names stage, owner, safe next action, evidence link, and customer-safe message. |
| Unresolved risk | Release owner | Open risks carry owner, mitigation, launch-note or cutline route, and revisit condition. |

## Pilot Note Routing

| Pilot Note Category | Owning Surface |
|---|---|
| Support gap | Support Workflow |
| Product UX | Workspace & Onboarding UX |
| Docs gap | V1 Release Notes & Upgrade Guide |
| Engineering gap | Owning engineering project |
| Go/no-go risk | V1 Release Program & Cutline |

## Script Follow-Up Gate

Customer onboarding automation, pilot execution, support tooling, or downstream implementation work
must wait until this script contract is accepted. Future usage also requires script review, assigned
support owner, and captured customer consent.
