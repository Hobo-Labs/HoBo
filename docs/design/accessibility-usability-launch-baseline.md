---
type: Reference
title: "Accessibility And Usability Launch Baseline"
description: "Source issue: HOBO-505."
tags: [hobo, design]
---

# Accessibility And Usability Launch Baseline

Source issue: HOBO-505.

Executable proof lives in
[`src/draft/exp-proofs/ux/accessibility-usability-launch-baseline-contract`](../../src/draft/exp-proofs/ux/accessibility-usability-launch-baseline-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-505-accessibility-usability-launch-baseline`](./proofs/hobo-505-accessibility-usability-launch-baseline/README.md).

## M0 Acceptance Record

HoBo v1 launch readiness needs explicit accessibility and usability evidence before workspace,
plan/diff, deployment, marketplace, docs, admin, support, or release artifacts can be treated as
customer-ready. This record defines the launch baseline. It does not implement product UI, perform a
full audit, or fix every defect surfaced by later checks.

## Launch Surfaces

| Surface | Owner project | Launch evidence use |
|---|---|---|
| Workspace/onboarding | Workspace & Onboarding UX | First-run entry, recovery, and value-proof states need accessibility evidence. |
| Plan/diff | Plan/Diff Viewer | Approval, cost, risk, and rollback decisions must be readable and operable. |
| Deployment dashboard/topology | Deployment Dashboard & Topology Explorer | Status, topology, failure, and next-action states must be navigable. |
| Marketplace install | Marketplace UX | Install, trust, warning, and review flows must avoid inaccessible launch claims. |
| Publisher portal | Publisher Portal | Publisher review, evidence upload, and warning flows need usable states. |
| Docs | V1 Release Notes & Upgrade Guide | Docs and known limitations must expose accessible support guidance. |
| Admin/support | V1 Launch Support Desk & Escalation | Admin and support users need triage paths that work without perfect vision or pointer input. |
| Release/support artifacts | V1 Release Program & Cutline | Go/no-go and accepted-risk records need explicit accessibility disposition. |

## Required Checks

| Check | Proof mode | Proves |
|---|---|---|
| Keyboard-only path | Manual assistive-tech check | Primary workflows can be completed without a mouse. |
| Focus order | Manual assistive-tech check | Keyboard focus follows task order and does not strand users. |
| Visible focus | Automated check | Interactive controls expose visible focus indicators. |
| Semantic labels | Automated check | Controls, landmarks, and form fields expose usable names and roles. |
| Contrast | Automated check | Text, controls, focus, and state indicators meet launch thresholds or carry a limitation. |
| Responsive layout | Automated check | Supported viewports avoid overlapping content and hidden required controls. |
| Reduced motion | Automated check | Motion-sensitive states have a reduced-motion posture. |
| Screen-reader smoke | Manual assistive-tech check | Representative first-run and support paths have screen-reader smoke evidence. |
| Empty/error/loading states | Reference fixture | Non-happy states explain state and next action without visual-only cues. |
| Copy clarity | Beta feedback | Critical launch copy is understandable to target personas and support can triage unclear copy. |

## Evidence Matrix

| Evidence mode | Owner project | Required before launch claim |
|---|---|---:|
| Automated checks | E2E Test Matrix | Yes |
| Manual assistive-tech checks | Accessibility & Usability Quality | Yes |
| Beta feedback | V1 Beta Pilot & Feedback Loop | No |
| Defect severity | V1 Release Program & Cutline | Yes |
| Launch-blocker threshold | V1 Release Program & Cutline | Yes |
| Accepted-risk exception | V1 Release Program & Cutline | No |

Launch blockers cannot be waived by accepted-risk exception. They exit only when the check passes,
the work is removed from launch scope, or evidence supports a downgrade without bypassing required
CI, review, security, or contract-test gates.

## Defect Routing

Defects route to the owning launch surface first: onboarding defects to Workspace & Onboarding UX,
plan/diff defects to Plan/Diff Viewer, deployment topology defects to Deployment Dashboard &
Topology Explorer, marketplace defects to Marketplace UX, publisher defects to Publisher Portal,
docs defects to Release Notes & Upgrade Guide, and admin/support defects to Launch Support Desk &
Escalation. Unknown or cross-surface findings route to the release cutline.

This prevents a generic accessibility bucket from hiding product ownership. The Accessibility &
Usability Quality project defines the baseline and severity rules; it does not become the owner of
every UI remediation.

## Scope Out

- Do not build product UI, dashboard screens, marketplace flows, support tooling, docs portal, or
  design-system components.
- Do not create a full accessibility audit report or claim certification.
- Do not fix every accessibility or usability defect in this issue.
- Do not waive launch blockers, CI, review, security, or contract-test gates.

## Authoritative Dependencies

- [Workspace & Onboarding UX](./workspace-onboarding-ux.md) names onboarding surfaces and explicitly
  scopes accessibility audit output out of workspace M0.
- [Launch Blocker Taxonomy](./launch-blocker-taxonomy.md) defines decision classes and exception
  boundaries.
- [Beta Pilot Feedback](./beta-pilot-feedback.md) routes usability feedback to Product UX and
  launch cutline owners.
- [Pre-Launch Outcome Contract](./pre-launch-outcome-contract.md) maps launch evidence into
  plan/diff, go/no-go, telemetry, support, and release-note surfaces.
- [AI Generation Safety Launch Posture](./ai-generation-launch-posture.md) keeps generated UI as a
  proposal until UX and accessibility evidence accepts it.

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Surface coverage fixture | Accessibility & Usability Quality | Contract test | Every v1 launch surface names owner and evidence use. |
| Required-check matrix | Accessibility & Usability Quality | Contract test | Keyboard, focus, semantic, contrast, responsive, motion, screen-reader, state, and copy checks are present. |
| Exception guard | V1 Release Program & Cutline | Contract test | Launch blockers and required gates cannot be bypassed. |
| Defect routing map | Owning product projects | Design record | Defects route to owners rather than a catch-all remediation bucket. |

## Follow-Up Gate

M1-M4 product UI, automated testing, manual audit, support, and remediation issues must wait until
this M0 baseline is accepted. This branch records the baseline and executable guard; it does not
create downstream implementation work.
