---
type: Reference
title: "Entitlements & Plan Limits"
description: "Source issue: HOBO-419."
tags: [hobo, design]
---

# Entitlements & Plan Limits

Source issue: HOBO-419.

Executable proof:
[`entitlements-plan-limits-scope`](../../src/draft/exp-proofs/cx/entitlements-plan-limits-scope/README.md)

Branch evidence:
[`proof record`](./proofs/hobo-419-entitlements-plan-limits/README.md)

Follow-up policy evidence:
[`HOBO-491 entitlement abuse, rate-limit, and fraud response proof`](./proofs/hobo-491-entitlement-abuse-rate-limit-policy/README.md)

This M0 record defines the accepted productization scope for plan entitlements and limits. It does
not build billing, runtime quota enforcement, RBAC, provider-quota sync, fraud/abuse response, live
customer plan mutation, or customer administration UI.

## M0 Acceptance Record

Entitlements & Plan Limits is accepted for M1 only when this record and the executable draft proof
agree on:

- the user/business goal and primary personas;
- scope in, scope out, and non-goals;
- service, UX, security, and support boundaries;
- owning initiative dependencies;
- M1 proof evidence; and
- the follow-up issue gate.

M1/M2/M3/M4 follow-up issues must wait until the M0 scope record is accepted.

## User And Business Goal

HoBo needs a precise entitlement and plan-limit promise before launch work can claim that plans,
workspace quotas, usage limits, grace states, or support overrides are safe. The business goal is to
avoid launch overclaims: workspace administrators should know which limits apply, platform engineers
should know which decision fixture later policy gates consume, support should have auditable override
rules, and billing/FinOps should see where plan/payment state stops and entitlement decisions start.

## Primary Personas

| Persona | Need |
|---|---|
| Workspace administrator | Understands which plan tier, workspace limits, grace states, and visible upgrade paths apply before launch. |
| Platform engineer | Needs a precise decision fixture for later policy gates, quotas, and runtime enforcement without building them here. |
| Billing/FinOps owner | Needs plan and usage handoff boundaries that reuse billing and metering evidence without turning this issue into invoicing. |
| Support operator | Needs safe limit explanations, override evidence, TTL, and escalation ownership without hidden quota grants. |
| Security/compliance reviewer | Confirms entitlement decisions are auditable, least-privilege, and do not bypass mandatory policy or tenant isolation. |

## Scope In

- Define accepted plan tier names and entitlement categories for private beta, paid team, and
  enterprise manual launch posture.
- Define limit decision states for allowed, warned, grace, denied, suspended, and
  override-approved cases.
- Map plan limit types for seats, projects, environments, runtime usage, request rate, concurrency,
  generation runs, spend reservation, and support tier.
- Record customer-visible copy and support/audit handoff rules for limit denials, grace, suspension,
  and approved overrides.
- List M1 evidence required before policy gates, runtime quota enforcement, billing integration, or
  settings UX work can fan out.

## Scope Out And Non-Goals

- Do not generate invoices, run checkout, collect payments, process refunds, calculate tax, apply
  chargeback, or move money.
- Do not implement runtime quota enforcement, a policy engine, rate limiter, provider quota sync, or
  production entitlement service.
- Do not implement member invite flows, RBAC role grants, authorization engines, or account
  administration UI.
- Do not implement abuse/fraud investigation workflows, appeals processes, suspension automation, or
  rate-limit response policy; that is follow-up HOBO-491 scope.
- Do not mutate live customer plans, build customer-facing billing pages, store provider credentials,
  or make final legal pricing claims.
- Do not create downstream M1-M4 execution issues before M0 scope is accepted.

## HOBO-491 Abuse, Rate-Limit, And Fraud Response Policy

HOBO-491 fills the follow-up gap named by this M0 record. The policy is accepted when the design
record and executable proof agree on:

- entitlement limit types that can trigger abuse, rate-limit, grace, suspension, appeal, and support
  override handling;
- rate-limit behavior for soft warning, backpressure, hard denial, and manual hold outcomes;
- customer-safe grace, appeal-open, suspended, recovered, and normal states;
- response rows for runaway usage, rate-limit exceeded, suspected fraud, confirmed abuse, and
  false-positive correction, each with audit evidence, customer communication, and recovery path;
- ownership boundaries for Billing & Credits, Tenant Isolation & Quotas, Security Verification, and
  Support Workflow; and
- scope guards that reject fraud scoring engine selection, risk-model tuning, live rate limiter
  implementation, payment-provider fraud webhooks, chargeback/refund workflows, customer suspension
  automation, and support ticket automation.

The executable proof lives in
[`entitlement-abuse-rate-limit-policy-contract`](../../src/draft/technical-proofs/entitlement-abuse-rate-limit-policy-contract/README.md).
HOBO-491 remains a policy contract: fraud scoring, runtime enforcement, billing provider
integration, support queue implementation, and live customer suspension remain out of scope.

## Plan Tiers

| Tier | M0 promise |
|---|---|
| Private beta free | Free private beta workspace with explicit beta limits and no invoice generation. |
| Team paid | Paid team posture can receive higher workspace/project limits after billing approval. |
| Enterprise manual | Enterprise limits are contract-defined and manually reviewed before automated enforcement. |

## Limit Types

| Limit type | Owner |
|---|---|
| Workspace seat | Settings & Project Lifecycle |
| Project count | Settings & Project Lifecycle |
| Environment count | Settings & Project Lifecycle |
| Runtime usage | Usage Metering |
| Request rate | Tenant Isolation & Quotas |
| Concurrency | Tenant Isolation & Quotas |
| Generation run | Usage Metering |
| Spend reservation | Billing & Credits |
| Support tier | Support Workflow |

## Entitlement Decision States

| State | Customer visible | Audit required | Notes |
|---|---:|---:|---|
| `entitlement.allowed` | No | Yes | Limit decision permits the action. |
| `entitlement.warn` | Yes | Yes | Approaching a limit; no denial yet. |
| `entitlement.grace` | Yes | Yes | Temporary grace path with owner and expiry. |
| `entitlement.denied` | Yes | Yes | Customer-safe reason and next step required. |
| `entitlement.suspended` | Yes | Yes | State follows billing/support policy; export/support access remains explicit. |
| `entitlement.override-approved` | Yes | Yes | Requires owner, reason, TTL, and audit evidence. |

## Service, UX, Security, And Support Boundaries

| Boundary | Owner | M0 decision |
|---|---|---|
| Service | Entitlements & Plan Limits | Owns accepted plan tier, limit type, decision-state, override, and M1 evidence records; runtime services implement later. |
| UX | Settings & Project Lifecycle | May later expose limit copy, upgrade prompts, and read-only entitlement state; mutation UX is out of this M0 issue. |
| Security | Security Verification | Requires auditability, least privilege, mandatory policy compatibility, and no hidden bypass for overrides. |
| Support | Support Workflow | Receives customer-safe denial reasons, override TTL, audit evidence, and escalation ownership without silent quota grants. |

## Owning Initiative Dependencies

| Initiative | Dependency |
|---|---|
| Entitlements & Plan Limits | Owns plan tier taxonomy, limit decision states, override evidence, and the M0 follow-up gate. |
| Usage Metering | Supplies usage facts and metering dimensions consumed by future limit decisions. |
| Billing & Credits | Supplies plans and payment states; invoices, payment, refunds, tax, and pricing remain there. |
| Tenant Isolation & Quotas | Supplies tenant and quota vocabulary; runtime isolation and noisy-neighbor proof remain there. |
| Settings & Project Lifecycle | Owns later workspace/project settings UX that may expose accepted entitlement state. |
| Support Workflow | Owns support queues, escalation, customer communication, and manual override operating procedure later. |
| V1 Release Program & Cutline | Uses M0 acceptance to decide when downstream M1-M4 issues may be created. |

## Evidence Required For M1

| Evidence | Mode | Proves |
|---|---|---|
| Plan entitlement taxonomy | Design record | Plan tiers, entitlement categories, and unsupported plan claims are explicit. |
| Limit decision fixture | Contract test | Allowed, warn, grace, denied, suspended, and override decisions are deterministic. |
| Usage metering handoff | Reference fixture | Usage-driven limits cite metering facts and do not invent hidden counters. |
| Customer-visible limit copy | UX copy record | Denials and grace states have customer-safe copy and upgrade/support routing. |
| Support override audit | Audit fixture | Manual overrides require owner, reason, TTL, and audit event before enforcement work begins. |
| Scope-boundary register | Policy fixture | Billing, runtime enforcement, RBAC, provider sync, abuse/fraud, and live-customer work route elsewhere. |

## Authoritative Dependencies

- [Usage Metering](./usage-metering.md) supplies usage fact classes, dimensions, and evidence
  handoff.
- [Billing Launch Policy](./billing-launch-policy.md) supplies launch plans, payment states, and
  billing boundaries.
- [Tenant Isolation & Quotas](./tenant-isolation-quotas.md) supplies tenant and quota vocabulary
  while runtime isolation remains separate.
- [Plan 05 reliability, observability, and cost](./reliability-observability-cost.md#plan-05)
  defines showback, quota, cost, and spend-safety context.
- [Plan 50 app tenancy](./security-networking.md#plan-50) defines app-tenant boundaries consumed by
  future entitlement decisions.
- [ADR-0039](./adr/02-identity-security.md#adr-0039) separates metering, quota, cost attribution,
  and showback from commercial billing.
- [ADR-0074](./adr/02-identity-security.md#adr-0074) keeps mandatory policy and RBAC governance as
  security boundaries this scope cannot bypass.
- [ADR-0064](./adr/07-portability-extensibility.md#adr-0064) keeps business monetization outside
  HoBo core; [ADR-0107](./adr/07-portability-extensibility.md#adr-0107) records plan-tier and
  entitlement productization for HoBo-the-hosted-business.

## Follow-Up Gate

Do not create M1/M2/M3/M4 Entitlements & Plan Limits follow-up issues until reviewers accept this
M0 scope record and its executable proof. Adjacent decisions route to the owning initiative above:
billing to Billing & Credits, usage facts to Usage Metering, tenant quota proof to Tenant Isolation
& Quotas, RBAC to Member/RBAC Administration, and abuse/fraud response to HOBO-491.
