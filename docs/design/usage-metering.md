---
type: Reference
title: "Usage Metering Scope And Acceptance"
description: "Source issue: HOBO-417."
tags: [hobo, design]
---

# Usage Metering Scope And Acceptance

Source issue: HOBO-417.

Executable proof lives in
[`src/draft/exp-proofs/cx/usage-metering-scope-contract`](../../src/draft/exp-proofs/cx/usage-metering-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-417-usage-metering`](./proofs/hobo-417-usage-metering/README.md).

## M0 Acceptance Record

Usage Metering exists to define the accepted productization boundary for usage facts, attribution
dimensions, showback evidence, reconciliation inputs, and support/audit handoff. It is not the
billing engine, entitlement service, Dispatcher/CreditLedger router, tax system, provider billing
sync, or customer-facing bill.

## User And Business Goal

HoBo needs accepted M0 scope for Usage Metering before downstream design/build work can depend on
usage facts. The accepted record must tell finance, platform, support, and security/compliance
reviewers which usage facts exist, which dimensions are required for showback, what M1 must prove,
and which adjacent initiatives own billing, entitlement, release, support, and compliance work.

## Primary Personas

| Persona | Need |
|---|---|
| FinOps owner | Explain tenant, project, run, resource, and generation usage as showback evidence without depending on live billing. |
| Platform engineer | Know which event families and dimensions downstream metering designs can rely on before building projections. |
| Billing/support operator | Trace disputed usage from invoice-adjacent summaries back to replayable facts and support handoff evidence. |
| Security/compliance reviewer | Confirm usage evidence preserves privacy, redaction, retention, and audit boundaries before customer exposure. |

## Scope In

- Canonical usage fact classes for control-plane operations, runtime compute, storage, egress,
  generation runs, and support adjustments.
- Attribution dimension matrix for tenant, workspace, project, environment, Camp, Bindle, run,
  agent, team, resource, and reporting period.
- Metering event evidence contract naming source event family, idempotency key, deduplication key,
  replay sequence, and redaction requirement.
- Reconciliation handoff from usage facts to billing launch policy and support dispute evidence
  without generating invoices.
- M1-ready evidence checklist for meter event catalog, dimension matrix, reconciliation fixtures,
  privacy/redaction policy, and support dispute handoff.

## Scope Out And Non-Goals

- Do not generate invoices, collect payments, apply refunds/credits, or calculate tax.
- Do not implement entitlement enforcement, hard quota gates, rate limits, abuse response, or fraud
  response.
- Do not implement Dispatcher/CreditLedger routing, reservation compare-and-swap, or maximize-credits
  selection.
- Do not sync with live provider billing APIs, store provider billing credentials, or build a
  production metering pipeline.
- Do not ingest live customer usage data, publish customer-visible bills, or make final
  legal/compliance launch claims.
- Do not create downstream M1-M4 execution issues before M0 scope is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Usage Metering M0 defines accepted facts, dimensions, evidence, and ownership boundaries; it does not build the projection service, event ingestion, or persistence layer. |
| UX | UX scope is the future information contract for showback, reconciliation, and support evidence, not a customer-visible bill or dashboard implementation. |
| Security | Usage facts must name retention, privacy, redaction, and replay/audit requirements without exposing live customer usage or provider billing credentials. |
| Support | Support receives dispute-ready fact lineage, adjustment classes, and reconciliation handoff rules; ticket routing, SLAs, and payment corrections remain separate. |

## Metering Fact Classes

| Fact class | Owner | Source event family | Sensitive |
|---|---|---|---:|
| Control-plane operation | Platform engineer | `deployment.*` | No |
| Runtime compute second | Platform engineer | `run.*` | No |
| Storage GB month | FinOps owner | `resource.*` | No |
| Egress GB | FinOps owner | `resource.*` | No |
| Generation run | Platform engineer | `gen.*` | Yes |
| Support adjustment | Billing/support operator | `meter.*` | Yes |

## Usage Dimension Matrix

M1 usage designs must account for these attribution dimensions before implementation starts:

| Dimension | Why it is required |
|---|---|
| Tenant | Required for showback, isolation, and support lookup. |
| Workspace | Required for customer-facing grouping and support handoff. |
| Project | Required for deployment, environment, and billing-policy reconciliation. |
| Environment | Required to separate production, preview, test, and ephemeral usage. |
| Camp | Required for campaign-level operational showback. |
| Bindle | Required for package/resource grouping in productization reports. |
| Run | Required for runtime and generation replay lineage. |
| Agent | Required for AI/runtime attribution and dispute triage. |
| Team | Required for organization-level reporting. |
| Resource | Required for compute, storage, egress, and provider-adjacent facts. |
| Period | Required for invoice-adjacent reconciliation windows. |

## Authoritative Dependencies

- [reliability-observability-cost.md#plan-05](./reliability-observability-cost.md#plan-05)
  defines MeteringView, usage dimensions, showback, quota, and cost-signal concepts consumed by
  this M0 scope.
- [data-plane.md#plan-11](./data-plane.md#plan-11) defines event-log and replay behavior that
  metering evidence must preserve without building a new runtime.
- [billing-launch-policy.md](./billing-launch-policy.md) defines launch billing boundaries consumed
  as reconciliation handoff, while invoice/payment work remains out of scope.
- [tax-currency-receipt-obligations.md](./tax-currency-receipt-obligations.md) defines legal/tax
  boundaries that metering must not silently absorb inside M0.
- [ADR-0039](./adr/02-identity-security.md#adr-0039) separates showback and quota policy from
  billing-engine implementation.
- [ADR-0071](./adr/01-architecture-core.md#adr-0071) pins Dispatcher/CreditLedger cost signals as a
  dependency, not Usage Metering scope.

## Owning Initiative Dependencies

| Owner | Consumes from Usage Metering | Boundary |
|---|---|---|
| Usage Metering | Accepted usage fact classes, attribution dimensions, evidence checklist, and follow-up gate. | This issue defines scope and acceptance; it does not build the metering projection. |
| Billing & Credits | Reconciled usage facts as invoice-adjacent evidence and dispute support. | Invoice generation, payment, refund, credit application, and tax remain in Billing & Credits. |
| Entitlements & Plan Limits | Usage categories and counts for later plan-limit policy design. | Entitlement enforcement, quota gates, and abuse handling stay in Entitlements & Plan Limits. |
| Compliance Evidence Pack | Retention, privacy, redaction, and replay/audit summaries for assurance evidence. | Legal approval, formal compliance claims, and customer assurance packets stay in Compliance Evidence Pack. |
| Support Workflow | Fact lineage, reconciliation fixtures, and adjustment evidence for disputes. | Support queues, SLAs, escalation, and payment correction workflows stay in Support Workflow. |
| V1 Release Program & Cutline | Accepted M0 record for deciding when M1-M4 follow-up issues may be created. | Release go/no-go, cutline decisions, and downstream issue creation remain release-program scope. |

## Evidence Required For M1

| Evidence | Owner | Source | Proof mode | Proves |
|---|---|---|---|---|
| Meter event fact catalog | Platform engineer | This document's fact-class table | Design record | Each accepted usage fact class names owner, source event family, sensitivity, and excluded implementation scope. |
| Usage dimension matrix | FinOps owner | This document's dimension matrix | Reference fixture | Showback dimensions cover tenant, project, run, resource, team, Camp, Bindle, and reporting period attribution. |
| Reconciliation fixture | Billing/support operator | Billing launch policy handoff | Contract test | Usage facts can reconcile into billing-policy/support evidence without generating invoices. |
| Privacy redaction policy | Security/compliance reviewer | Security/support boundary record | Privacy review | Usage evidence declares retention, redaction, replay, and live-data exclusion boundaries. |
| Support dispute handoff | Billing/support operator | Owning-initiative boundary table | Support handoff | Support can trace disputed usage to fact lineage and adjustment evidence without owning billing corrections. |

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 scope record is accepted. This
branch records the gate and its executable guard; it does not create follow-up implementation
issues.
