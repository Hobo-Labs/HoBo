---
type: Reference
title: "Workspace Activation Telemetry Contract"
description: "Source issue: HOBO-486."
tags: [hobo, design]
---

# Workspace Activation Telemetry Contract

Source issue: HOBO-486.

Executable proof lives in
[`src/draft/exp-proofs/cx/workspace-activation-telemetry-contract`](../../src/draft/exp-proofs/cx/workspace-activation-telemetry-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-486-workspace-activation-telemetry`](./proofs/hobo-486-workspace-activation-telemetry/README.md).

## M0 Acceptance Record

Workspace onboarding needs a small, privacy-safe activation telemetry contract before design and
implementation work can claim first-run success. The contract is not an analytics platform and not a
customer-success profile. It is the compact evidence map that lets onboarding, plan review,
deployment status, support, beta feedback, and release readiness answer whether a workspace reached
first useful handoff and where recovery failed.

## Required Activation Events

| Event | Owner project | Product question | Support or recovery use |
|---|---|---|---|
| Account created | Organization & Workspace Model | Can a user create the account needed to start a workspace? | Distinguishes account setup failures from later workspace failures. |
| Workspace created | Workspace & Onboarding UX | Does onboarding get the user into a usable workspace? | Resumes setup from the workspace boundary without replaying account creation. |
| Project created | Settings & Project Lifecycle | Does the first workspace produce a project that can own deploy evidence? | Routes empty-workspace reports to project setup rather than deployment. |
| First plan created | Plan/Diff Viewer | Can the user produce a first plan or diff before attempting launch? | Lets support inspect the plan record when deploy fails before infrastructure changes. |
| First deploy attempted | Deployment Dashboard & Topology Explorer | Does the first plan reach a deploy attempt with visible status? | Separates planning friction from launch or runtime friction. |
| First failure recovered | Support & Debug Tools | Can the user recover from the first blocking failure without abandoning onboarding? | Names the failing step, remediation route, and successful retry boundary. |
| First successful handoff | V1 Beta Pilot & Feedback Loop | Did onboarding hand the user to a stable next action after first value evidence? | Identifies whether the user reached docs, beta feedback, support, or launch review. |

## Privacy, Retention, And Customer Choice

| Rule | Constraint | Retention | Customer choice | Exclusion |
|---|---|---|---|---|
| Purpose-limited events | Events answer first-run activation and recovery questions only. | Event summaries stay with workspace onboarding evidence through the beta review window. | Customers can see event classes and product questions in launch documentation. | No heatmaps, session replay, raw clickstream, or behavioral profiling. |
| PII and secret exclusion | Captured fields use tenant, workspace, project, plan, deploy, and event references. | Persist references and classified outcomes, not raw customer text or provider payloads. | Customer-authored names can be redacted or replaced by stable refs in exports. | No raw email addresses, secrets, credentials, tokens, payment data, or provider credentials. |
| Workspace retention window | Retention follows workspace support, beta feedback, release readiness, and audit handoff windows. | Delete or aggregate activation telemetry after the support/review window unless audit policy retains refs. | Workspace admins can request export or deletion under the privacy/legal readiness policy. | No new analytics warehouse or customer-success profile is created. |
| Customer opt-out and export | Opt-out disables non-essential product analytics while preserving mandatory audit/support facts. | Opt-out state is retained with the workspace settings record. | Admins can inspect opt-out state and export activation evidence used for support. | Opt-out cannot be bypassed by routing events to an unapproved vendor. |

## Evidence Ownership

| Evidence | Owner | Proof mode |
|---|---|---|
| Event catalog fixture | Workspace & Onboarding UX | Contract test |
| Owner mapping | Workspace & Onboarding UX | Design record |
| First-run recovery mapping | Support & Debug Tools | Support handoff |
| Privacy and opt-out rules | V1 Legal, Privacy & Terms Readiness | Launch limitation record |
| Pre-launch value comparison | Plan/Diff Viewer / Workspace & Onboarding UX | Link to the [pre-launch outcome contract](./pre-launch-outcome-contract.md) |

## Scope Out

- No live analytics vendor selection.
- No behavioral tracking platform, heatmap, session replay, or raw clickstream capture.
- No broad profile, CRM, customer-success lifecycle, or cross-tenant recommendation memory.
- No product UI, telemetry pipeline, storage backend, or event ingestion implementation.

## Authoritative Dependencies

- HOBO-409 owns Workspace & Onboarding UX M0 scope and acceptance.
- HOBO-507 owns persona operating profile and recommendation memory. This contract only maps
  first-run telemetry consumption and explicitly excludes broad profile or cross-tenant memory.
- HOBO-508 owns the outcome activation rail. This contract supplies first-run activation evidence,
  not the rail orchestration layer.
- HOBO-509 owns the pre-launch outcome baseline. This contract names the telemetry signals that can
  compare against that baseline.
- [Plan 05](./reliability-observability-cost.md#plan-05) and
  [ADR-0046](./adr/02-identity-security.md#adr-0046) own broader telemetry standards and boundary
  export posture.

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 telemetry contract is accepted.
This branch records the event catalog, privacy boundaries, and executable guards; it does not create
telemetry ingestion, analytics storage, dashboard, or vendor-selection work.
