---
type: Reference
title: "V1 Readiness Dashboard Contract"
description: "Source issue: HOBO-482."
tags: [hobo, design]
---

# V1 Readiness Dashboard Contract

Source issue: HOBO-482.

Executable proof lives in
[`src/draft/exp-proofs/ux/v1-readiness-dashboard-contract`](../../src/draft/exp-proofs/ux/v1-readiness-dashboard-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-482-v1-readiness-dashboard`](./proofs/hobo-482-v1-readiness-dashboard/README.md).

## M0 Acceptance Record

The V1 Release Program needs one dashboard contract for release decision evidence. This dashboard is
an aggregate of accepted release evidence, not a feature implementation or go/no-go automation
engine. Its job is to prevent unknown blockers, missing proof links, stale milestone health, or
unowned accepted risks from appearing ready.

## Required Fields

| Field | Source of truth | Update cadence | Empty-state meaning |
|---|---|---|---|
| Cutline | Accepted V1 cutline contract plus the V1 Release Program & Cutline Linear project. | On M0 acceptance and before beta, release-candidate, and GA decisions. | Missing cutline is red; release cannot claim a shared v1 boundary. |
| Blockers | Launch Blocker Taxonomy records, failed gates, and open Linear blocker issues. | Every gate run, blocker triage, and go/no-go review. | Unknown blockers are red and treated as not ready. |
| Milestone health | Linear project milestone state and latest status update. | At milestone transition and before each readiness review. | Missing health is yellow and requires owner refresh before decision. |
| Evidence links | Traceability row, proof README, PR link, and verification command output. | Whenever evidence changes or a release decision is prepared. | Missing evidence is red and cannot render as green. |
| Accepted risks | Launch Blocker Taxonomy exception records with approver, mitigation, and expiry. | On risk acceptance, expiry, mitigation change, or go/no-go review. | No accepted risks is neutral, not proof that blockers are closed. |
| Owners | Linear project owners, initiative owners, and named readiness owner fields. | On ownership change and before every release decision. | Unowned evidence or blockers are red. |
| Last verified | Latest verification run timestamp attached to the proof or release record. | Every verification run and immediately before release decision. | Never verified is red and cannot count as current readiness. |

## Source-Of-Truth Rules

- Linear remains the live work-state source for issues, blockers, milestones, owners, and status
  updates.
- Design records and proof packages remain the durable evidence source for accepted M0 contracts.
- Pull requests and verification logs supply branch evidence, but they do not replace design records
  or Linear state.
- Missing evidence, unknown blockers, absent owners, and never-verified records fail closed; they are
  not green, even when no explicit failure is known.

## Scope Boundaries

This M0 contract only aggregates release evidence. It does not build a runtime dashboard UI,
provider deploy implementation, support tool, legal approval workflow, or automated go/no-go
decision engine. Feature implementation remains in the owning productization, platform, support,
legal/privacy, documentation, and operations projects.

## Design Links

- [V1 cutline proof](../../src/draft/technical-proofs/v1-cutline-contract/README.md) defines launch scope
  boundaries.
- [Launch Blocker Taxonomy](./launch-blocker-taxonomy.md) defines blocker and accepted-risk classes.
- [Pre-Launch Outcome Contract](./pre-launch-outcome-contract.md#surface-mapping) maps launch
  go/no-go consumers.
- [Workspace Onboarding UX](./workspace-onboarding-ux.md#owning-initiative-dependencies) already routes
  onboarding gaps to the readiness dashboard and cutline project.
