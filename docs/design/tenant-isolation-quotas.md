---
type: Reference
title: "Tenant Isolation & Quotas"
description: "Source issue: HOBO-415"
tags: [hobo, design]
---

# Tenant Isolation & Quotas

Source issue: HOBO-415

Executable proof:
[`tenant-isolation-quotas-scope`](../../src/draft/exp-proofs/dx/tenant-isolation-quotas-scope/README.md)

Branch evidence:
[`proof record`](./proofs/hobo-415-tenant-isolation-quotas/README.md)

This M0 record defines the accepted productization scope for tenant isolation and quotas. It does
not build tenant isolation runtime behavior, quota enforcement, RBAC, provider provisioning,
billing, or launch/customer data paths.

## M0 Acceptance Record

Tenant Isolation & Quotas is accepted for M1 only when this record and the executable draft proof
agree on:

- the user/business goal and primary personas;
- scope in, scope out, and non-goals;
- service, UX, security, and support boundaries;
- owning initiative dependencies;
- M1 proof evidence; and
- the follow-up issue gate.

M1/M2/M3/M4 follow-up issues must wait until the M0 scope record is accepted.

## User And Business Goal

HoBo needs a precise tenant isolation and quota promise before downstream design work claims that
customer data, tenant routing, noisy-neighbor controls, showback, or support views are safe. The
business goal is to avoid launch overclaims: app developers should understand what HoBo can prove,
workspace administrators should know where tenant and quota claims are visible, and support/security
operators should have a reviewable evidence path before implementation work begins.

## Primary Personas

| Persona | Need |
|---|---|
| Workspace administrator | Understands which tenants, projects, and app tenants are isolated and where quota evidence becomes visible. |
| Platform engineer | Needs owned boundaries for platform tenant containment, quota fixtures, and noisy-neighbor evidence. |
| App developer | Declares app tenancy without learning HoBo platform tenancy internals or receiving billing promises. |
| Support operator | Needs support-safe identifiers, escalation handoffs, and redaction rules without cross-tenant disclosure. |

## Scope In

- Define four tenant-related axes that must not collapse: platform tenant, project, app tenant, and
  end-user.
- Record the v1 tenancy models: pooled, region-pooled, siloed, and bridge.
- Name quota dimensions for request rate, concurrency, projection lag, connection pool partition,
  sink storage, and spend reservation/showback.
- Map service, UX, security, and support boundaries for tenant isolation and quota claims.
- List M1 evidence required before downstream design/build issues can be created.

## Scope Out And Non-Goals

- Billing, subscriptions, invoices, payment handling, tax, and chargeback implementation.
- Runtime tenant isolation engines, policy engines, quota enforcers, provider provisioning, or
  dedicated Yard creation.
- Member invite flows, RBAC administration, or authorization grant implementation.
- Tenant self-service admin UI beyond evidence fields and support-visible handoff requirements.
- Live customer data migration, production tenant rollout, or customer-facing launch readiness
  claims.
- Replacing the Bindle, Camp, Yard, and Junction infrastructure containment model.
- Collapsing platform tenants and app tenants into one generic tenant identifier.
- Promising noisy-neighbor elimination for pooled or region-pooled app tenancy.

## Tenant Axes

| Axis | Meaning | Boundary |
|---|---|---|
| Platform tenant | HoBo account/org using the platform | Hard HoBo boundary for data, compute, credentials, network, policy, and support disclosure. |
| Project | Planning and rollup grouping inside one platform tenant | Never spans platform tenants; does not create a new containment tier. |
| App tenant | The application's own customer or tenant partition | Carried in app context and proved by conformance later. |
| End-user | Principal inside an app tenant | Does not expand platform tenant or app tenant scope. |

## Tenancy Models

| Model | M0 guarantee | Honest limit |
|---|---|---|
| Pooled | Shared infrastructure with tenant-aware context, guards, quotas, and conformance. | Noisy-neighbor risk is bounded, not eliminated. |
| Region-pooled | Pooled by region or residency slice with the same tenant guards and region-aware placement evidence. | Region scope does not become a billing or provider commitment in M0. |
| Siloed | Dedicated infrastructure for one app tenant or cohort. | Dedicated infrastructure is design evidence only here; provisioning is out. |
| Bridge | Mixed transition posture that states which side owns each tenant path. | Bridge is not a hidden migration project in M0. |

## Quota Dimensions

| Dimension | Owner | M1 proof expectation |
|---|---|---|
| Request rate | Tenant Isolation & Quotas | Per-tenant request budgets and denial semantics are declared. |
| Concurrency | Tenant Isolation & Quotas | Concurrent work limits and saturation behavior are declared. |
| Projection lag | Data Plane | Per-tenant lag budgets and stale-label behavior are recorded. |
| Connection pool | Security Verification | Pooled-store and search-path partitioning requirements are recorded. |
| Sink storage | Reliability, Observability & Cost | Per-tenant sink storage caps and exhaustion handling are recorded. |
| Spend reservation | Billing & Credits | Showback/reservation evidence only; money movement stays out. |

## Service, UX, Security, And Support Boundaries

| Boundary | Owner | M0 decision |
|---|---|---|
| Service | Tenant Isolation & Quotas | Owns terminology, tenancy-model choices, quota dimensions, and proof expectations. |
| UX | Settings & Project Lifecycle | Exposes tenant/quota evidence as read-only product claims until later UX work owns configuration. |
| Security | Security Verification | Requires cross-tenant-leak, no-tenant fail-closed, and noisy-neighbor guard evidence. |
| Support | Support Workflow | Defines support-safe identifiers, escalation handoffs, and redaction rules. |

## Owning Initiative Dependencies

| Initiative | Dependency |
|---|---|
| Organization & Workspace Model | Supplies account, organization, workspace, project, and environment vocabulary. |
| Settings & Project Lifecycle | Owns settings and project lifecycle surfaces that may later expose tenant/quota claims. |
| Member/RBAC Administration | Owns owner and operator grants; this scope records the required handoff only. |
| Billing & Credits | Provides showback-only handoff; billing, invoices, payments, and chargeback stay out. |
| Security Verification | Owns M1 leak, fail-closed, and noisy-neighbor conformance proof. |
| Support Workflow | Owns support escalation, safe identifiers, and customer communication templates later. |

## Evidence Required For M1

| Evidence | Mode | Proves |
|---|---|---|
| Tenant-axis model | Design record | Platform tenant, project, app tenant, and end-user axes remain distinct. |
| Cross-tenant-leak gate | Conformance gate | Positive and negative leak cases fail closed when tenant context is missing or mismatched. |
| Quota-policy fixture | Reference fixture | Quota dimensions, decisions, and denial reasons are declared before implementation. |
| Noisy-neighbor fixture | Contract test | Pooled models bound noisy-neighbor impact and siloed models remove shared contention. |
| Showback-support handoff | Support handoff | Support and showback surfaces disclose only approved tenant/quota evidence. |
| Scope-boundary register | Policy fixture | Billing, RBAC, runtime, provider, and customer-data work is routed to owning initiatives. |

## Authoritative Dependencies

- [Plan 50 app tenancy](./security-networking.md#plan-50)
- [Plan 12 security and platform multitenancy](./security-networking.md#plan-12)
- [Plan 10 architecture containment](./architecture.md#plan-10)
- [Plan 49 operations and status surfaces](./developer-experience.md#plan-49)
- [ADR-0039 metering, quota, and cost attribution](./adr/02-identity-security.md#adr-0039)
- [ADR-0074 governance, RBAC, and mandatory policy](./adr/02-identity-security.md#adr-0074)
- [ADR-0077 projects and environments](./adr/02-identity-security.md#adr-0077)
- [ADR-0079 app multi-tenancy](./adr/02-identity-security.md#adr-0079)
- [ADR-0080 tenant isolation by construction](./adr/02-identity-security.md#adr-0080)

## Follow-Up Gate

Do not create M1/M2/M3/M4 Tenant Isolation & Quotas follow-up issues until reviewers accept this
M0 scope record and its executable proof. Adjacent decisions route to the owning initiative above:
billing to Billing & Credits, member/role grants to Member/RBAC Administration, project settings to
Settings & Project Lifecycle, and escalation/status claims to Support Workflow.
