---
type: Reference
title: "Persona Operating Profile And Recommendation Memory"
description: "Source issue: HOBO-507."
tags: [hobo, design]
---

# Persona Operating Profile And Recommendation Memory

Source issue: HOBO-507.

Executable proof lives in
[`src/draft/technical-proofs/persona-operating-profile-contract`](../../src/draft/technical-proofs/persona-operating-profile-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-507-persona-operating-profile`](./proofs/hobo-507-persona-operating-profile/README.md).

## M0 Acceptance Record

The v1 persona operating profile is a compact workspace/client profile that improves onboarding
recommendations, safe-test defaults, approval defaults, cost caps, workspace settings, and
first-run telemetry without creating a broad profile system. It carries only explicit,
tenant-scoped operating facts and recommendation decisions derived from those facts.

This record adapts the competitive extension evidence from QUI-91 into HoBo release-readiness
scope. QUI-91 remains the source evidence; this branch does not duplicate the full Quickdeploy
implementation backlog.

## Minimal V1 Profile Fields

| Field | Why it exists | Primary consumers |
|---|---|---|
| Industry | Helps select launch-safe examples and regulated-workflow warnings. | Workspace onboarding, safe-test packs, release notes |
| Team type | Tunes setup for solo, startup, agency, or enterprise use. | Onboarding defaults, approval defaults, cost guardrails |
| Approved systems | Prevents recommendations from ignoring already approved tools. | Recommendation ranking, permission explanations |
| Blocked systems | Filters disallowed integrations before tests or launch claims. | Safe-test selection, policy review |
| Risk posture | Sets conservative, standard, or exploratory defaults. | Approval defaults, safe-test depth, launch guardrails |
| Approval owner | Names who must approve risky recommendations or cost exceptions. | Policy handoff, support handoff |
| Cost cap | Keeps launch suggestions inside budget tolerance. | Cost-control defaults, metering/billing handoff |
| Safe-test depth | Selects smoke, simulated, or provider-backed proof depth. | Example Apps, Security Verification |
| Existing workflows | Explains recommendations against current manual or automated work. | Client reports, migration notes |
| Primary outcomes | Ranks recommendations by business outcome rather than raw prompt text. | Outcome activation rail, docs handoff |
| Do-not-do boundaries | Turns explicit user or organization boundaries into filters and blockers. | Approval defaults, policy review, support |

## Required Mappings

Every profile field must map to:

- Personas: Marcus, Sarah, Priya, Elena, Morgan where relevant.
- Onboarding defaults: the first-run state or prompt it changes.
- Safe-test packs: which fixture family or proof depth it selects or rejects.
- Approval defaults: when it routes to admin, platform owner, security, or support.
- Cost caps: whether it sets, tightens, or routes budget exceptions.
- Workspace settings: the stable setting key that owns the field.
- First-run telemetry: the activation evidence class that may reference the field.

## Recommendation Memory Definition

For v1, recommendation memory means explicit tenant-workspace profile facts plus recommendation
decisions derived from those facts. It can explain how a profile changed ranking, safe-test
defaults, permission explanations, cost-control defaults, or Priya-style client reports.

Post-v1 work includes adaptive ranking models, behavioral personalization, cross-tenant
recommendation memory, and broad customer-success or CRM profiles.

## Privacy, Retention, And Customer Choice

| Rule | Policy | Owner |
|---|---|---|
| Purpose and minimization | Collect only fields that affect recommendations, safe tests, approvals, cost caps, settings, or first-run telemetry. | Workspace & Onboarding UX / Legal, Privacy & Terms |
| Retention window | Retain profile records with workspace settings and beta support evidence, then aggregate or delete by policy. | Provenance & Retention |
| Edit and delete | Workspace admins can edit or delete profile fields without deleting required audit/support facts. | Settings & Project Lifecycle / Support Workflow |
| Export redaction | Exports redact sensitive approved or blocked systems unless an authorized admin explicitly includes them. | Legal, Privacy & Terms / Support Workflow |
| Tenant boundary | Profile memory never crosses tenant or client-workspace boundaries by default. | Tenant Isolation & Quotas / Organization & Workspace Model |

## Scope Out

- No ML personalization platform.
- No broad behavioral tracking, heatmaps, session replay, or raw clickstream capture.
- No cross-tenant recommendation memory.
- No broad CRM, customer-success lifecycle profile, or marketing automation profile.
- No product UI, storage backend, recommendation engine, or telemetry pipeline implementation.

## Authoritative Dependencies

- QUI-91 supplies the competitive persona gap evidence and target personas.
- [workspace-onboarding-ux.md](./workspace-onboarding-ux.md) owns the first-run product rail.
- [workspace-activation-telemetry-contract.md](./workspace-activation-telemetry-contract.md)
  owns first-run telemetry consumption and explicitly excludes broad profile tracking.
- [outcome-activation-rail.md](./outcome-activation-rail.md) consumes persona/profile labels for
  outcome selection and proof handoff.
- [organization-workspace-model.md](./organization-workspace-model.md) owns tenant, workspace,
  project, and environment vocabulary.
- [ADR-0079](./adr/02-identity-security.md#adr-0079) and
  [ADR-0080](./adr/02-identity-security.md#adr-0080) own app tenant and isolation posture.

## Follow-Up Gate

M1/M2/M3/M4 implementation, UI, profile persistence, recommendation ranking, or telemetry work must
wait until this M0 contract is accepted. This branch records the profile boundary and executable
guards; it does not build the product surface.
