---
type: Reference
title: "Org Catalogs Scope And Acceptance"
description: "Source issue: HOBO-424."
tags: [hobo, design]
---

# Org Catalogs Scope And Acceptance

Source issue: HOBO-424.

Executable proof lives in
[`src/draft/exp-proofs/dx/org-catalogs-scope-acceptance`](../../src/draft/exp-proofs/dx/org-catalogs-scope-acceptance/README.md).
Branch evidence is summarized in
[`proofs/hobo-424-org-catalogs`](./proofs/hobo-424-org-catalogs/README.md).

## M0 Acceptance Record

Org Catalogs defines the workspace-visible approved catalog boundary for provider packs, resource
packs, template Bindles, policy packs, and private listings. This M0 record names the nouns, states,
evidence fields, owner handoffs, and proof gate before schema, approval workflow, policy, registry,
or support implementation issues can rely on it.

It does not build registry storage, marketplace UI, RBAC grants, install resolution, provider
execution, billing, or policy enforcement.

## User And Business Goal

HoBo needs an explicit org catalog scope so workspace admins can govern approved capabilities,
platform engineers can rely on curated inputs, app developers can understand available templates and
packs, and support operators can explain catalog states without overclaiming installability or
marketplace trust.

## Primary Personas

| Persona | Need |
|---|---|
| Workspace administrator | Review approved entries, owners, lifecycle state, policy pins, and workspace visibility. |
| Platform engineer | Consume approved provider and resource-pack inputs without taking registry or resolver scope. |
| App developer | See which templates and capability packs are available to the current workspace. |
| Support operator | Explain entry state, owner, limitations, and escalation path without exposing private catalog data. |

## Scope In

- Define catalog kinds for provider packs, resource packs, template Bindles, policy packs, and
  private listings.
- Define catalog entry states: proposed, approved, deprecated, blocked, and retired.
- Define required entry evidence: source, owner, trust tier, scope, version pin, policy, and support
  handoff.
- Map service, UX, security, and support boundaries for approved catalog claims.
- List the M1 evidence required before schema, approval, policy, registry, or support work can
  proceed.

## Scope Out And Non-Goals

- Live registry storage, artifact publication, catalog backends, and install-time resolver runtime.
- Marketplace storefront, publisher portal UI, ratings, paid placement, revenue share, and payouts.
- RBAC role grants, approver workflows, member management, and authorization enforcement.
- Provider execution, resource provisioning, default-provider registration, and capability
  conformance runs.
- Billing, subscriptions, invoices, tax, chargebacks, and commercial packaging.
- Replacing Registry distribution, marketplace trust tiers, provider conformance, or organization
  and workspace ownership models.
- Treating catalog approval as a substitute for signed provenance, security review, or policy
  evaluation.

## Catalog Kinds

| Kind | Meaning |
|---|---|
| Provider pack | Approved provider packages, defaults, and capability specs an org may use. |
| Resource pack | Signed Resource Packs or capability listings accepted for a workspace. |
| Template Bindle | Starter or sample Bindles approved for onboarding and workspace reuse. |
| Policy pack | Mandatory or default policy packs available to the org or workspace. |
| Private listing | Enterprise-private or side-loaded entries visible only to approved org scopes. |

## Entry States

| State | Meaning |
|---|---|
| Proposed | Submitted for org review but not usable by default. |
| Approved | Approved for the recorded org scope with explicit evidence and policy pins. |
| Deprecated | Still visible for existing use while upgrade, replacement, or retirement evidence is prepared. |
| Blocked | Denied for new use because evidence, trust, policy, security, or support conditions failed. |
| Retired | No longer selectable and retained only for audit, support, or historical explanation. |

## Required Entry Evidence

| Field | Owner | M1 proof expectation |
|---|---|---|
| Source | Registry & Distribution | Names registry, private source, or side-loaded origin. |
| Owner | Org Catalogs | Names the org/workspace owner responsible for review and lifecycle state. |
| Trust tier | Marketplace Publisher Trust Evidence | Records generated, verified, curated, or enterprise-private posture. |
| Scope | Organization & Workspace Model | Records org, workspace, project, environment, or private visibility boundary. |
| Version pin | Portability, Registry & Distribution | Records immutable version or digest requirements for approved use. |
| Policy | Member/RBAC Administration | Records mandatory/default policy packs or approver authority. |
| Support handoff | Support Workflow | Records customer-safe limitations, escalation owner, and unsupported states. |

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Org Catalogs owns catalog nouns, entry states, evidence fields, and M1 proof expectations; storage and resolver services are later work. |
| UX | Marketplace UX / Publisher Portal may present approved entries later; this M0 record defines information architecture only. |
| Security | Member/RBAC Administration owns approver authority and authorization checks; this record names required handoffs and policy evidence. |
| Support | Support Workflow consumes support-safe entry state, owner, limitation, and escalation evidence without adding support tooling. |

## Authoritative Dependencies

- [Organization & Workspace Model](./organization-workspace-model.md) defines org, workspace,
  project, and environment visibility vocabulary.
- [Settings & Project Lifecycle](./settings-project-lifecycle.md) defines workspace/project owner
  and support/audit handoff patterns.
- [Marketplace Publisher Trust Evidence](./marketplace-publisher-trust-evidence.md) defines
  generated, verified, curated, and enterprise-private trust tiers.
- [Walkthrough](./walkthrough.md) describes the hosted cloud's pre-approved catalog expectation.
- [Plan 21](./authoring-resources-wiring.md#plan-21) defines authoring resource catalog and
  manifest inputs that org catalogs may expose but not implement here.
- [Plan 29](./contracts-policy-flags.md#plan-29) defines policy-pack consumption and Gatekeeper
  boundaries.
- [ADR-0062](./adr/07-portability-extensibility.md#adr-0062) pins Registry distribution,
  publish/discover/install/trust, and signed artifacts.
- [ADR-0074](./adr/02-identity-security.md#adr-0074) pins org governance, RBAC, and mandatory
  policy rules.
- [ADR-0073](./adr/07-portability-extensibility.md#adr-0073) pins swappable integration ports.
- [ADR-0075](./adr/07-portability-extensibility.md#adr-0075) pins capability spec stability tiers.
- [ADR-0095](./adr/07-portability-extensibility.md#adr-0095) pins distributed-artifact version
  resolution semantics.

## Owning Initiative Dependencies

| Owner | Consumes from Org Catalogs | Boundary |
|---|---|---|
| Organization & Workspace Model | Org, workspace, project, and environment scope vocabulary. | Does not define catalog states or approval evidence. |
| Registry & Distribution | Catalog source, version pin, deprecation, yank, and install-resolution handoff. | Registry storage, artifact publishing, and resolver runtime remain outside M0 scope. |
| Marketplace Publisher Trust Evidence | Trust tiers, curation posture, private listing posture, and warning evidence. | Marketplace review UI, ratings, payouts, and storefront behavior stay outside this issue. |
| Member/RBAC Administration | Approver authority, policy pins, mandatory/default policy evidence, and authorization handoff. | Role grants, member workflows, and enforcement stay outside this issue. |
| Marketplace UX / Publisher Portal | Later display and management surfaces can consume accepted entry fields. | No UI, interaction flow, or publisher workflow is built here. |
| Support Workflow | Support-safe owner, state, scope, limitation, and escalation evidence. | Support tooling, SLA, ticketing, and customer communication execution stay outside this issue. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Catalog schema | Org Catalogs | Design record | Catalog kind, entry state, evidence field, and visibility records are stable. |
| Approval state machine | Org Catalogs | Contract test | Proposed, approved, deprecated, blocked, and retired states transition deterministically. |
| Policy consumption fixture | Member/RBAC Administration | Reference fixture | Mandatory/default policy and approver evidence are consumed without implementing RBAC. |
| Registry handoff | Registry & Distribution | Integration contract | Registry publication, resolver, version, deprecation, and yank work remains owned elsewhere. |
| Support export | Support Workflow | Support handoff | Support can explain entry owner, state, scope, limitation, and escalation path. |
| Scope boundary register | Org Catalogs | Policy fixture | Marketplace, registry, RBAC, billing, provider execution, and UI work are routed out. |

## Follow-Up Gate

M1/M2/M3/M4 org-catalog schema, approval workflow, registry handoff, policy consumption, support
export, or UI issues must wait until this M0 scope record is accepted. This branch records the gate
and executable guard; it does not create follow-up implementation issues.
