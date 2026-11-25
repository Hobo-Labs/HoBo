---
type: Reference
title: "Tenant Data Lifecycle"
description: "Source issue: HOBO-492."
tags: [hobo, design]
---

# Tenant Data Lifecycle

Source issue: HOBO-492.

Executable proof lives in
[`src/draft/exp-proofs/cx/tenant-data-lifecycle-contract`](../../src/draft/exp-proofs/cx/tenant-data-lifecycle-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-492-tenant-data-lifecycle`](./proofs/hobo-492-tenant-data-lifecycle/README.md).

## M0 Acceptance Record

Compliance Evidence Pack needs a tenant data lifecycle inventory before enterprise readiness,
privacy, deletion/export, backup/restore, support, or customer assurance claims can be made. This
record defines the data classes, retention posture, deletion/export expectations, residency
sensitivity, owner lanes, v1 limitations, account-closure obligations, and downstream evidence
gate. It is not legal approval, live customer data deletion, a storage retention service, a support
access grant, or billing implementation.

## User And Business Goal

HoBo needs a customer-assurance-ready map of tenant data before beta or GA claims mention privacy,
deletion, retention, or residency. Customers need to understand what classes of data HoBo handles,
what can be exported or deleted, what is retained for legal/audit/support reasons, and which parts
are manual, deferred, unsupported, or future work.

## Primary Personas

| Persona | Need |
|---|---|
| Compliance lead | Needs data classes, retention posture, residency sensitivity, and limitation evidence for customer assurance packets. |
| Privacy owner | Needs deletion/export expectations, retained exceptions, and legal/privacy handoffs before notices or DPA content are approved. |
| Security reviewer | Needs audit, break-glass, and customer-data risk boundaries before security claims are published. |
| Support operator | Needs customer-safe routing for deletion/export, account closure, retained exceptions, and support-data redaction. |
| Customer admin | Needs clear data-class, deletion/export, retention, and residency limitations without hidden automation claims. |

## Scope In

- Define customer product data, telemetry, logs, generated artifacts, support data, billing data,
  and audit data for v1 customer assurance.
- Record retention, deletion/export expectation, residency sensitivity, owner, and v1 limitation
  for every data class.
- Define deletion and account-closure obligation states for supported, manual, deferred, and
  impossible-with-rationale requests.
- Map legal/privacy, security, backup/restore, support, provenance, and tenant-isolation handoffs.
- List M1 evidence required before deletion/export implementation, support tooling, backup service,
  storage retention, or legal approval work can fan out.

## Scope Out And Non-Goals

- Do not approve final DPA, privacy policy, legal terms, subprocessor lists, or legal signoff.
- Do not implement live customer data deletion, account closure automation, erasure workflows, or
  production data mutation.
- Do not build storage backends, retention schedulers, purge jobs, backup services, artifact stores,
  or SIEM export pipelines.
- Do not implement support desks, grant production customer data access, or approve break-glass use.
- Do not implement billing, invoices, tax, payment, refund, or money movement systems.
- Do not create downstream M1-M4 implementation issues before M0 scope is accepted.

Non-goals:

- Replace Legal, Privacy & Terms Readiness or final legal owner approval.
- Replace Backup & Restore drill evidence or Provenance & Retention artifact classes.
- Promise production deletion/export automation before deterministic M1 proof exists.
- Use live customer data or grant support access in this M0 record.

## Data Class Inventory

| Data class | Owner | Retention | Deletion/export expectation | Residency sensitivity | V1 limitation |
|---|---|---|---|---|---|
| Customer product data | Compliance Evidence Pack | Product stores plus accepted backup/restore windows. | Supported export/delete path must be named before beta customer data. | High. | No production deletion automation claim. |
| Telemetry | Workspace & Onboarding UX | Privacy-reviewed purpose and activation evidence windows. | Distinguish aggregate metrics from tenant-identifiable telemetry. | Medium. | No telemetry opt-out or deletion workflow implementation here. |
| Logs | Support Workflow | Redacted diagnostic context for support/security windows. | Distinguish customer-visible logs from internal diagnostics. | Medium. | No live log pipeline, tailing service, or deletion runner. |
| Generated artifacts | Provenance & Retention | Artifact retention classes for generated code, manifests, certifications, and provenance. | Preserve provenance/yank obligations and customer-access boundaries. | Medium. | No artifact purge or invalidation runner. |
| Support data | Support Workflow | Redacted bundles and tickets for launch support windows. | Preserve audit and incident evidence handoffs. | High when bundles include tenant identifiers or customer content. | No helpdesk or support data access approval. |
| Billing data | Billing & Credits | Billing/legal owner retention for invoice, receipt, and tax metadata. | Distinguish legal retention from customer-request cleanup. | High. | No invoicing, payment, tax, or money movement system. |
| Audit data | Security Verification | Security, policy, break-glass, and support audit integrity windows. | Preserve immutable audit requirements and assurance evidence. | High. | No SIEM export or compliance approval workflow. |

## Deletion And Account-Closure Obligations

| State | Owner | Customer-safe rule | Audit evidence |
|---|---|---|---|
| Supported export | Compliance Evidence Pack | Export is supported when the data class has an accepted export source and owner. | Export-request record with data class, tenant, owner, source, and completion evidence. |
| Supported delete | Compliance Evidence Pack | Deletion is supported when erasure evidence exists and no legal retention block applies. | Deletion-request record with data class, tenant, owner, deletion evidence, and retained-exception list. |
| Manual review | Support Workflow | Manual review is required when support, security, billing, or legal ownership must approve the path. | Manual-review record with reviewer, reason, decision, and customer communication owner. |
| Deferred retention | Legal, Privacy & Terms Readiness | Deletion is deferred when legal retention, audit integrity, or recovery evidence must be retained. | Retention-deferral record with rationale, expiry, owner, and customer-safe limitation. |
| Impossible with rationale | Compliance Evidence Pack | Deletion/export is impossible only with explicit technical or legal rationale and owner signoff. | Impossible-request record with rationale, owner, affected data classes, and appeal route. |

## Authoritative Dependencies

- [legal-privacy-terms-readiness.md](./legal-privacy-terms-readiness.md) owns DPA, privacy notice,
  legal terms, subprocessor approval, and legal retention exceptions.
- [security-verification.md](./security-verification.md) owns security claims, audit and
  break-glass review, and customer-data risk handling.
- [backup-restore.md](./backup-restore.md) owns backup-source inventory, restore drills, RPO/RTO
  limitations, and recovery retention handoffs.
- [support-sla-channels.md](./support-sla-channels.md) owns support intake, customer-safe routing,
  support-data redaction, and manual review handoff.
- [provenance-retention.md](./provenance-retention.md) owns generated artifact provenance,
  retention classes, support debug access, and invalidation evidence.
- [tenant-isolation-quotas.md](./tenant-isolation-quotas.md) owns tenant-axis vocabulary and keeps
  platform tenant, project, app tenant, and end-user data boundaries distinct.
- [ADR-0060](./adr/02-identity-security.md#adr-0060) keeps compliance/data governance evidence
  export explicit without turning HoBo into a legal certification program.
- [ADR-0080](./adr/02-identity-security.md#adr-0080) requires tenant isolation evidence before
  cross-tenant claims.

## Owning Initiative Dependencies

| Owner | Consumes from Tenant Data Lifecycle | Boundary |
|---|---|---|
| Compliance Evidence Pack | Data inventory, deletion/export obligations, account closure routing, and customer assurance evidence. | This issue defines scope and acceptance; it does not publish final assurance claims. |
| Legal, Privacy & Terms Readiness | Retention exceptions, DPA/privacy notice inputs, and subprocessor/legal owner gaps. | Final legal approval stays outside this issue. |
| Security Verification | Audit, break-glass, customer-data risk, and security claim evidence. | Security verification gates and disclosure remain in Security Verification. |
| Backup & Restore | Data-class retention and recovery limitations that affect restore drill claims. | Backup storage, restore execution, and live recovery remain in Backup & Restore. |
| Support Workflow | Manual review, support-data redaction, and customer-safe routing. | Ticket queues, support tooling, and data-access approval stay outside this issue. |
| Provenance & Retention | Generated artifact and provenance data-class rules. | Artifact store, purge, invalidation, and retention job implementation stay in Provenance & Retention. |
| Tenant Isolation & Quotas | Tenant-axis vocabulary for inventory and residency sensitivity. | Runtime tenant isolation and quota enforcement remain there. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Data-inventory register | Compliance Evidence Pack | Design record | Every data class names owner, retention, deletion/export expectation, residency sensitivity, and limitation. |
| Retention matrix | Legal, Privacy & Terms Readiness | Policy fixture | Retention windows and retained exceptions are explicit before customer assurance claims. |
| Deletion/export obligation fixture | Compliance Evidence Pack | Contract test | Supported, manual, deferred, and impossible deletion/export requests route deterministically. |
| Account-closure routing | Support Workflow | Support handoff | Account closure distinguishes cleanup, retained legal/audit records, and customer messaging. |
| Residency-sensitivity map | Privacy owner | Privacy review | Data classes requiring residency or PII review are visible before implementation. |
| Support-assurance handoff | Support Workflow | Customer assurance packet | Support and customer assurance requests cite accepted evidence without overclaiming automation. |
| Scope-boundary register | Compliance Evidence Pack | Policy fixture | Legal approval, live deletion, storage implementation, support access, billing, and SIEM work route elsewhere. |

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 scope record and executable
proof are accepted. This branch records the gate and its executable guard; it does not create
follow-up implementation issues.
