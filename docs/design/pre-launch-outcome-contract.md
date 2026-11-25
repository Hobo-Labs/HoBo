---
type: Reference
title: "Pre-Launch Outcome Contract And Value Baseline"
description: "Source issue: HOBO-509."
tags: [hobo, design]
---

# Pre-Launch Outcome Contract And Value Baseline

Source issue: HOBO-509.

Executable proof lives in
[`src/draft/exp-proofs/cx/pre-launch-outcome-contract`](../../src/draft/exp-proofs/cx/pre-launch-outcome-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-509-pre-launch-outcome-contract`](./proofs/hobo-509-pre-launch-outcome-contract/index.md).

## M0 Acceptance Record

HoBo v1 deploys need a customer-visible outcome baseline before launch. The baseline is not a legal
SLA and not a customer-success system. It is the compact record that lets plan review, safe tests,
launch decisions, monitoring, support, and later value follow-up compare actual behavior against the
user's stated success basis.

## Minimal V1 Outcome Fields

| Field | Owner | Customer visible | Purpose |
|---|---|---|---|
| Intended business outcome | Launch requester | Yes | States what the deploy is supposed to improve. |
| Success signal | Launch requester | Yes | Names the metric, observation, or sample result that indicates value. |
| Owner | Workspace admin | Yes | Names the approver and review owner. |
| Cost cap | Workspace admin | Yes | Sets the spend boundary used by plan review and support. |
| Approval rule | Workspace admin | Yes | States the human approval rule for launch or risky actions. |
| Failure rule | Support owner | Yes | Defines pause, escalation, or no-go behavior. |
| Rollback expectation | Support owner | Yes | Defines what rollback, disable, or manual fallback should do. |
| Review date | Launch requester | Yes | Sets the comparison window for beta feedback and post-launch value review. |

Governed launches also require explicit access and control confirmation before they can complete:
systems/data classes confirmed, plus pause, disable, and rollback controls confirmed.

## Surface Mapping

| Surface | Owner project | How it consumes the baseline |
|---|---|---|
| Plan/Diff | Plan/Diff Viewer | Shows baseline next to resource, cost, policy, and rollback diff before approval. |
| Launch go/no-go | V1 Release Program & Cutline | Blocks launch when governed owner, cost, access, or control evidence is missing. |
| Telemetry | Workspace & Onboarding UX | Names privacy-safe signals compared against the baseline after launch. |
| Beta feedback | V1 Beta Pilot & Feedback Loop | Routes feedback against outcome, owner, failure rule, and review date. |
| Support handoff | V1 Launch Support Desk & Escalation | Gives support the success, cost, pause, failure, and rollback basis. |
| Release notes / known limitations | V1 Release Notes & Upgrade Guide | Turns unsupported outcome, evidence, cost, or rollback claims into limitations. |

## Evidence Requirements

| Evidence | Owner project | Proof mode | Compares against |
|---|---|---|---|
| Safe-test sample cases | E2E Test Matrix | Reference fixture | Success signal |
| Safe-test result pack | E2E Test Matrix | Contract test | Intended business outcome |
| Plan/diff baseline | Plan/Diff Viewer | Design record | Cost cap |
| Post-launch comparison window | Workspace & Onboarding UX | Telemetry contract | Review date |
| Support review export | V1 Launch Support Desk & Escalation | Support handoff | Failure rule |

Safe-test artifacts can support launch confidence, but they cannot be promoted into a live provider
success claim without provider-backed evidence.

## Privacy, Retention, And Customer Visibility

| Rule | Customer visibility | Retention | Exclusion |
|---|---|---|---|
| Customer-visible baseline | The eight baseline fields are visible to the deploying customer. | Stored with the deployment record through the review window and release-support retention period. | Internal policy notes and support-only redactions are excluded. |
| PII and secret exclusion | Baseline text may be customer-authored but must not require PII, secrets, credentials, or raw provider data. | Only redacted references or fixture IDs persist in telemetry and support exports. | PII, secret values, provider credentials, and raw customer records are excluded. |
| Retention by deployment | The customer can inspect the active deployment baseline and review date. | Retention follows deployment, audit, release-note, and support handoff policies. | No separate warehouse or broad profile is created here. |
| Support redaction boundary | Support sees the customer-readable baseline plus redacted evidence links. | Support exports keep enough evidence to explain launch, pause, and rollback decisions. | Simulated or safe-test evidence cannot become a live-provider claim. |

## Source Evidence

- [QUI-92](https://linear.app/quickdeploy-ai/issue/QUI-92/competitive-extension-pre-launch-outcome-contract-and-value-baseline)
  is preserved as the competitive extension source.
- [Competitive Persona Gap Synthesis - 2026-06-11](https://linear.app/quickdeploy-ai/document/competitive-persona-gap-synthesis-2026-06-11-cad78262d922)
  supplies the gap that value proof starts too late.
- QuickDeployAI Customer Personas supplies the persona rule that every capability must answer who
  it is for, what outcome it supports, how it can be tested and monitored, and how it can be
  controlled, paused, disabled, or changed.

## Scope Out

- No analytics warehouse.
- No automated ROI model.
- No full customer-success lifecycle.
- No live provider-success claim without provider-backed evidence.
