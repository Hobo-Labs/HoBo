---
type: Reference
title: "Audit Explorer Scope And Acceptance"
description: "Source issue: HOBO-427."
tags: [hobo, design]
---

# Audit Explorer Scope And Acceptance

Source issue: HOBO-427.

Executable proof lives in
[`src/draft/exp-proofs/ux/audit-explorer-scope-contract`](../../src/draft/exp-proofs/ux/audit-explorer-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-427-audit-explorer`](./proofs/hobo-427-audit-explorer/README.md).

## M0 Acceptance Record

Audit Explorer defines the launch-critical read-only audit surface for policy decisions,
credential events, control-plane actions, deployment/run/resource activity, support handoffs, and
redacted export evidence. This M0 record names the audit fact classes, tenant-first query axes,
export evidence shape, service/UX/security/support boundaries, owning initiative handoffs, and
follow-up gate before design/build issues can depend on Audit Explorer.

It does not build UI, event-store storage, projector runtime, search indexing, export delivery,
RBAC enforcement, support ticketing, CLI/MCP commands, identity runtime, or live customer-data
search.

## User And Business Goal

HoBo needs accepted M0 scope for Audit Explorer before downstream design/build work can rely on
audit exploration, replay, export, or support/security evidence semantics. The accepted record must
tell security reviewers, support operators, workspace admins, platform engineers, and governance
leads which audit facts are in scope, which filters and exports later contracts must prove, which
adjacent initiatives own implementation, and what evidence M1 must provide.

## Primary Personas

| Persona | Need |
|---|---|
| Security/compliance reviewer | Prove who did what, under which policy decision, and with which redaction state without exposing credential material. |
| Support operator | Inspect customer-safe audit context for incident handoff without taking ticketing or SLA workflow scope. |
| Workspace admin | Review project, environment, principal, agent, and export activity inside tenant and RBAC boundaries. |
| Platform engineer | Debug control-plane decisions, deploy actions, policy gates, and token-broker events from replayable projections. |
| Governance lead | Assemble evidence packets and OCSF-aligned export requirements with retention and redaction status. |

## Scope In

- Audit Explorer user/business goal, personas, and accepted M0 audit-read scope.
- Audit fact classes for policy decisions, credential events, control-plane actions,
  deployment/run/resource events, support handoff, and export redaction evidence.
- Tenant-first query filter axes and read-only export evidence shape for later contract proof.
- Service, UX, security, and support boundaries across Admin Console, Support Workflow, Security
  Verification, Governance/Compliance Evidence, Data Plane, CLI/MCP, and Identity/Auth.
- M1-ready evidence for audit fact contracts, filter contracts, redaction fixtures, export
  manifests, support handoff context, replay reconstruction, and follow-up gating.

## Scope Out And Non-Goals

- Do not build Audit Explorer screens, routes, components, client state, or interaction flows in
  this issue.
- Do not implement event-store storage, projector runtime, search indexing, pagination, SIEM
  connectors, or export delivery services.
- Do not implement RBAC enforcement, policy evaluation, role binding, break-glass access, or
  authorization runtime.
- Do not read provider credentials, expose credential material, search unredacted customer content,
  mutate customer state, or execute admin/support actions.
- Do not create M1-M4 implementation issues until this M0 acceptance record is accepted.
- Do not replace Admin Console navigation, Support Workflow ticketing, Security Verification
  suites, Data Plane event-store contracts, legal retention obligations, customer assurance
  language, production export pricing, or OCSF delivery mechanics.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Audit Explorer defines read-only audit fact, filter, and export contract boundaries; event-store persistence, projector runtime, search indexing, and export delivery remain later service work. |
| UX | Audit Explorer defines information architecture, query axes, empty/error states, and evidence classes; it does not build screens, components, routes, or interactions in this issue. |
| Security | Audit Explorer requires tenant-first filters, least-privilege read authority, redaction, no credential-material exposure, and replayable policy evidence without implementing authorization. |
| Support | Audit Explorer defines customer-safe support context and handoff fields; Support Workflow owns tickets, SLA routing, and escalation execution. |

## Audit Fact Classes

| Class | Owner | Event families | Customer visible | Redaction required |
|---|---|---|---:|---:|
| Policy decision audit | Security Verification | `policy.Decided`, `policy.Denied`, `policy.OverrideRejected` | Yes | Yes |
| Credential audit | Identity/Auth | `token.Granted`, `token.Used`, `token.Revoked` | No | Yes |
| Control-plane action audit | Admin Console | `policy.Decided`, `crew.ActionProposed`, `deployment.PlanRejected` | Yes | Yes |
| Deployment/run/resource audit | Data Plane | `deployment.*`, `run.*`, `resource.*` | Yes | Yes |
| Support escalation audit | Support Workflow | `incident.Opened`, `crew.HandoffRequested` | No | Yes |
| Export redaction audit | Governance/Compliance Evidence | `data.Classified`, `erasure.Requested`, `erasure.Completed` | Yes | Yes |

## Query And Export Contract

Tenant is the first filter axis and project is second. Later M1 contracts must also preserve
environment, principal, agent, action, resource, time, policy-decision, evidence-kind,
redaction-state, and correlation-id filters. Export evidence must be redacted and must include:

- Actor/action/target/timestamp with tenant and correlation id.
- Policy decision context with rule id, effect, denial reason, and redaction state.
- Credential event summary with principal, grant id, event family, revocation state, and redaction
  state.
- Support handoff summary with incident id, customer-safe context, owner, and redaction state.
- OCSF evidence manifest with schema family, retention marker, export id, and redaction state.

## Authoritative Dependencies

- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines dashboard, run
  inspection, replay, and audit surfaces that Audit Explorer later specializes.
- [developer-experience.md#plan-49](./developer-experience.md#plan-49) defines operations dashboard
  and status-page projections that must consume the same read-model discipline.
- [data-plane.md#plan-11](./data-plane.md#plan-11) defines event audit trail, identity/auth events,
  projections, and read models as the source for audit exploration.
- [contracts-policy-flags.md#plan-29](./contracts-policy-flags.md#plan-29) defines policy
  decisions, control-plane action audit, governance exports, and boundary standards consumed by
  audit facts.
- [ai-native-agent-auth.md#plan-06](./ai-native-agent-auth.md#plan-06) defines credential audit
  events for grants, token use, revocation, and delegated agent activity.
- [governance-planes.md#plan-46](./governance-planes.md#plan-46) defines governance evidence and
  compliance export expectations that Audit Explorer must route to owning initiatives.
- [ADR-0046](./adr/02-identity-security.md#adr-0046) pins OCSF, trace propagation, boundary
  standards, and replayable audit envelopes.
- [ADR-0074](./adr/02-identity-security.md#adr-0074) pins org governance, RBAC, mandatory policy
  rules, deny ceilings, and audit obligations.
- [ADR-0077](./adr/02-identity-security.md#adr-0077) pins projects and environments as tenant-first
  grouping dimensions for dashboard and status surfaces.
- [ADR-0050](./adr/03-data-plane.md#adr-0050) pins event-sourced projections, materialized views,
  read stores, and replay semantics.

## Owning Initiative Dependencies

| Owner | Consumes from Audit Explorer | Boundary |
|---|---|---|
| Audit Explorer | Accepted audit fact classes, tenant-first filters, export evidence shape, and M1 proof gates. | This issue defines scope and acceptance; it does not build UI, search, projector, or export runtime. |
| Admin Console | Future navigation entry points and workspace/project/environment context for audit exploration. | Admin Console owns UI navigation and action-intent surfaces, not audit fact semantics. |
| Support Workflow | Customer-safe audit context, incident identifiers, redaction status, and handoff summaries. | Ticket queues, SLA routing, escalations, and customer communications remain outside Audit Explorer. |
| Security Verification | No-credential-exposure, redaction, tenant isolation, and policy-decision fixtures as conformance inputs. | RBAC enforcement, policy engines, leak tests, and authorization runtime stay with Security Verification. |
| Governance/Compliance Evidence | Export manifest fields, OCSF alignment, retention markers, and evidence packet requirements. | Legal retention rules, compliance claims, and export delivery remain owning-governance work. |
| Data Plane | Event-store envelopes, projection semantics, replay cursors, materialized views, and read-store snapshots. | Event storage, projector runtime, search indexing, pagination, and snapshot persistence remain Data Plane work. |
| CLI/MCP & Developer Experience | Audit read models for inspect/replay commands and diagnostic entry points. | CLI verbs, MCP tools, and dashboard interactions are not implemented in this issue. |
| Identity/Auth | Credential audit facts, principal references, delegated agent grants, and revocation evidence. | Token brokerage, session revocation, credential issuance, and identity policy remain Identity/Auth work. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Audit fact class register | Audit Explorer | Design record | Policy, credential, control-plane, deployment/run/resource, support, and export-redaction audit fact classes are named with owners. |
| Query filter contract | Audit Explorer | Contract test | Tenant-first filter axes, project/environment grouping, principal/action/resource/time filters, and redaction state are contract-visible. |
| Redaction and no-secret fixture | Security Verification | Audit fixture | Audit facts include redaction status and reject credential material or unredacted customer content exposure. |
| Export evidence manifest | Governance/Compliance Evidence | Reference fixture | OCSF-aligned export evidence names schema family, actor/action/target/timestamp, retention marker, and redaction state. |
| Support handoff context | Support Workflow | Support handoff | Support context can be attached to an incident handoff without implementing ticket queues or SLA automation. |
| Replay reconstruction fixture | Data Plane | Audit fixture | Projection snapshots can be reconstructed from event families without bypassing event-store/read-store ownership. |
| Follow-up issue gate | Audit Explorer | Policy fixture | M1/M2/M3/M4 Audit Explorer issues remain blocked until this M0 record is accepted. |

## Follow-Up Gate

M1/M2/M3/M4 Audit Explorer UI, service, support, export, security, data-plane, CLI/MCP, or identity
implementation issues must wait until this M0 scope record is accepted. This branch records the
gate and its executable guard; it does not create follow-up implementation issues.
