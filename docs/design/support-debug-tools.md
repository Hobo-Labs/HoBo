---
type: Reference
title: "Support & Debug Tools Scope And Acceptance"
description: "Source issue: HOBO-426."
tags: [hobo, design]
---

# Support & Debug Tools Scope And Acceptance

Source issue: HOBO-426.

Executable proof lives in
[`src/draft/exp-proofs/cx/support-debug-tools-scope-contract`](../../src/draft/exp-proofs/cx/support-debug-tools-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-426-support-debug-tools`](./proofs/hobo-426-support-debug-tools/README.md).

## M0 Acceptance Record

Support & Debug Tools defines the launch-critical diagnostic and recovery handoff surface for
support operators, on-call responders, workspace admins, platform engineers, and security reviewers.
This M0 record names support-safe diagnostic bundle classes, recovery routes, redaction rules,
service/UX/security/support boundaries, owning initiative handoffs, and follow-up gates before
design/build work can depend on support debugging semantics.

It does not build UI, ticket queues, helpdesk integrations, live log or trace collectors,
event-store runtime, runbook remediation, RBAC enforcement, provider credential access, or raw
customer-data access.

## User And Business Goal

HoBo needs accepted M0 scope for Support & Debug Tools before downstream design/build work can rely
on diagnostic bundles, first-run recovery, incident handoff, or support-safe troubleshooting
semantics. The accepted record must tell support, SRE, administrators, platform engineers, and
security reviewers which facts are safe to expose, which adjacent initiatives own implementation,
and what M1 proof must provide.

## Primary Personas

| Persona | Need |
|---|---|
| Support operator | Assemble customer-safe diagnostic context with owner, severity, redaction state, and next route without accessing secrets or live data. |
| On-call responder | Receive incident and recovery handoffs with correlation ids, timeline evidence, and safe runbook ownership without hidden remediation authority. |
| Workspace admin | Understand which project, environment, resource, and support state are affected without seeing internal credentials or raw customer data. |
| Platform engineer | Debug deploy, plan, runtime, provider, and drift failures from replayable facts and projected diagnostics. |
| Security/compliance reviewer | Verify support diagnostics are tenant-scoped, redacted, audited, and least-privilege before support tooling is implemented. |

## Scope In

- Support & Debug Tools user/business goal, personas, and accepted M0 diagnostic scope.
- Support-safe diagnostic bundle classes for first-run recovery, deploy/plan rejection, auth or
  policy denial, provider or network drift, runtime health, and incident handoff.
- Recovery routes from customer-visible symptoms to owning initiatives with safe next action,
  evidence source, and no mutation authority.
- Service, UX, security, and support boundaries across Admin Console, Audit Explorer, Support
  Workflow, Operators/SRE, Reliability/Observability/Cost, CLI/MCP, Data Plane, and Security
  Verification.
- M1-ready evidence for diagnostic bundles, redaction fixtures, route matrices, read-only tool
  intents, incident handoff context, replay correlation, and follow-up gating.

## Scope Out And Non-Goals

- Do not build Support & Debug Tools screens, routes, components, client state, or interaction
  flows in this issue.
- Do not implement support ticket queues, helpdesk integrations, SLA automation, staffing
  workflows, or customer communication dispatch.
- Do not implement live log tailing, trace collection, event-store storage, projector runtime,
  search indexing, or read-store persistence.
- Do not execute runbook remediation, restart services, mutate live customer state, apply fixes, or
  perform rollback/restore actions.
- Do not read provider credentials, credential secret values, secret material, unredacted logs, or
  raw customer data.
- Do not implement RBAC enforcement, policy evaluation, role binding, break-glass access, or
  authorization runtime.
- Do not create M1-M4 implementation issues until this M0 acceptance record is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Support & Debug Tools defines diagnostic bundle and recovery route contract boundaries; observability pipelines, event storage, projectors, and remediation execution remain later service work. |
| UX | Support & Debug Tools defines information architecture, bundle fields, and route states; it does not build screens, components, routes, or interactions in this issue. |
| Security | Support diagnostics require tenant-first scoping, redaction, auditability, least-privilege read authority, and no credential or raw customer data exposure without implementing authorization. |
| Support | Support & Debug Tools defines support handoff evidence and safe next actions; Support Workflow owns ticket queues, SLAs, staffing, customer communications, and escalation execution. |

## Diagnostic Bundle Classes

| Class | Owner | Event families | Customer visible | Redaction required |
|---|---|---|---:|---:|
| First-run recovery | Support & Debug Tools | `env.Cloned`, `session.Started` | Yes | Yes |
| Deploy plan rejection | CLI/MCP & Developer Experience | `deployment.PlanRejected`, `policy.Denied`, `compat.GateFailed` | Yes | Yes |
| Auth/policy denial | Security Verification | `token.Revoked`, `policy.Denied`, `session.Revoked` | No | Yes |
| Provider/network drift | Operators/SRE | `drift.RemediationRouted`, `resource.DriftDetected`, `provider.Deprecated` | No | Yes |
| Runtime health summary | Reliability/Observability/Cost | `slo.BudgetBurned`, `run.StepCompleted`, `incident.Opened` | Yes | Yes |
| Incident support handoff | Support Workflow | `incident.Opened`, `incident.Escalated`, `crew.HandoffRequested` | No | Yes |

Each diagnostic bundle must include `tenant`, `project`, `environment`, and `correlation-id` before
any narrower field. Bundles may include owner, step, plan id, policy rule, resource ref, service
status, SLO state, severity, or incident id only when redacted and safe for support handoff.

## Recovery Route Matrix

| Route | Owner | Safe next action |
|---|---|---|
| First-run failure | Support & Debug Tools | Attach recovery owner, failing step, accepted limitation, and retry guidance without executing the retry. |
| Deploy plan rejected | CLI/MCP & Developer Experience | Route to plan evidence, denial reason, owning gate, and remediation issue owner without overriding the gate. |
| Auth or policy denied | Security Verification | Expose redacted policy and principal references, then route to security owner without granting access. |
| Provider or network drift | Operators/SRE | Attach resource reference, drift class, SLO state, and runbook owner without invoking the runbook. |
| Incident handoff | Support Workflow | Attach incident id, severity, customer-safe summary, redaction state, and communication owner. |

## Authoritative Dependencies

- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines inspect, logs, run
  inspector, dashboard, and CLI/MCP views that support diagnostics later consume.
- [developer-experience.md#plan-49](./developer-experience.md#plan-49) defines operations
  dashboard, project/environment grouping, status surfaces, and incident/status projection
  discipline.
- [workspace-activation-telemetry-contract.md](./workspace-activation-telemetry-contract.md) names
  first failure recovered as a Support & Debug Tools product question and recovery use.
- [admin-console.md](./admin-console.md) defines admin-visible project, environment, entitlement,
  support, and security context consumed by support diagnostics.
- [audit-explorer.md](./audit-explorer.md) defines audit facts, tenant-first filters, redaction,
  export evidence, and support handoff context.
- [support-sla-channels.md](./support-sla-channels.md) defines support channels, response language,
  unsupported request routing, and support workflow boundaries.
- [launch-support-escalation.md](./launch-support-escalation.md) defines severity routing, incident
  communication templates, support/debug prerequisites, and gap routing.
- [operators-sre.md#plan-40](./operators-sre.md#plan-40) defines incident management, runbooks,
  operator agents, and autonomous-action boundaries.
- [data-plane.md#plan-11](./data-plane.md#plan-11) defines event audit trail, projections, replay,
  and materialized views used by diagnostic bundles.
- [ADR-0074](./adr/02-identity-security.md#adr-0074) pins org governance, RBAC, mandatory policy
  rules, deny ceilings, and audit obligations.
- [ADR-0050](./adr/03-data-plane.md#adr-0050) pins event-sourced projections, materialized views,
  read stores, and replay semantics.
- [ADR-0058](./adr/03-data-plane.md#adr-0058) pins incidents, runbooks, self-healing decisions, and
  SRE handoff semantics.

## Owning Initiative Dependencies

| Owner | Consumes from Support & Debug Tools | Boundary |
|---|---|---|
| Support & Debug Tools | Accepted diagnostic bundle classes, recovery route matrix, support-safe fields, and M1 proof gates. | This issue defines scope and acceptance; it does not build UI, services, live diagnostics, or remediation. |
| Admin Console | Project, environment, entitlement, support, and security context for support-visible diagnostics. | Admin Console owns UI navigation, read models, and action intents, not diagnostic bundle semantics. |
| Audit Explorer | Audit facts, redaction status, export evidence, and correlation ids for support handoff. | Audit Explorer owns audit querying and export shape, not support workflow execution. |
| Support Workflow | Bundle classes, route owners, severity hints, and unsupported-request routing. | Ticket queues, SLA routing, staffing, and customer communications stay in Support Workflow. |
| Operators/SRE | Incident handoff, runbook owner, remediation boundary, and escalation state. | Runbook execution, auto-fix, rollback, restore, and incident command automation stay in Operators/SRE. |
| Reliability/Observability/Cost | Metrics, logs, traces, SLO burn, health, drift, and cost context as read-only evidence sources. | Telemetry pipelines, alert routing, SLO engines, and cost enforcement stay outside this M0 record. |
| Security Verification | No-secret exposure, redaction, tenant scoping, and least-privilege fixture requirements. | RBAC enforcement, policy engines, break-glass runtime, and leak tests stay with Security Verification. |
| CLI/MCP & Developer Experience | Diagnostic bundle and route semantics for future inspect, doctor, logs, and MCP support tools. | CLI verbs, MCP tools, dashboards, and inspector implementation are not built in this issue. |
| Data Plane | Replayable events, projection cursors, materialized views, and read-store snapshot semantics. | Event storage, projector runtime, live log tailing, search indexing, and persistence remain Data Plane work. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Diagnostic bundle contract | Support & Debug Tools | Contract test | First-run, deploy, auth, provider, runtime, and incident bundles have owner, source events, redaction, and safe fields. |
| Redaction and no-secret fixture | Security Verification | Audit fixture | Diagnostics reject provider credentials, secret material, raw customer data, and unredacted logs. |
| Recovery route matrix | Support & Debug Tools | Reference fixture | Support symptoms route to first-run, deploy, auth, drift, or incident owners with safe next actions. |
| Read-only tool intent | CLI/MCP & Developer Experience | Design record | Future inspect, doctor, logs, and MCP tools are read-only until separate implementation issues grant authority. |
| Incident handoff context | Support Workflow | Support handoff | Support can attach severity, incident id, owner, and customer-safe summary without ticket automation. |
| Replay correlation fixture | Data Plane | Replay fixture | Diagnostic bundles can cite projection snapshots and correlation ids without owning event-store runtime. |
| Follow-up issue gate | Support & Debug Tools | Policy fixture | M1/M2/M3/M4 Support & Debug Tools issues remain blocked until this M0 record is accepted. |

## Follow-Up Gate

M1/M2/M3/M4 Support & Debug Tools UI, service, diagnostics, support workflow, remediation, CLI/MCP,
security, data-plane, or observability implementation issues must wait until this M0 scope record is
accepted. This branch records the gate and its executable guard; it does not create follow-up
implementation issues.
