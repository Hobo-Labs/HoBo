---
type: Reference
title: "Troubleshooting Guides Scope and Acceptance"
description: "Source issue: HOBO-437."
tags: [hobo, design]
---

# Troubleshooting Guides Scope and Acceptance

Source issue: HOBO-437.

Executable proof lives in
[`src/draft/exp-proofs/dx/troubleshooting-guides-scope-acceptance`](../../src/draft/exp-proofs/dx/troubleshooting-guides-scope-acceptance/README.md).
Branch evidence is summarized in
[`proofs/hobo-437-troubleshooting-guides-scope`](./proofs/hobo-437-troubleshooting-guides-scope/index.md).

## M0 Acceptance Record

Troubleshooting Guides exists to turn failed HoBo workflows into safe diagnostic paths without
hiding product, support, incident, status-page, or runtime remediation work inside documentation
scope. This M0 record defines what later M1 design and contract issues must prove before any guide
implementation can claim the v1 troubleshooting path is ready.

## User And Business Goal

HoBo needs launch-safe troubleshooting guidance that helps humans and coding agents classify common
failure states, collect the right evidence, redact sensitive material, and route to the right owner.
Guides can explain symptoms and safe next actions, but they cannot implement support queues,
runtime fixes, provider repair, incident communications, status-page publishing, or final docs
portal behavior.

## Primary Personas

| Persona | Need |
|---|---|
| First-time app developer | Map a failed first run, plan, deploy, auth, or inspection step to likely cause, safe retry, and evidence to keep. |
| Coding agent | Follow deterministic symptom checks and refusal states without using private local knowledge or credentials. |
| Support operator | Receive concise handoff records with symptom, owner, safe next action, and redacted evidence. |
| Platform engineer | Separate local setup, provider catalog, policy, networking, identity, and hosted-service failure domains. |
| Docs maintainer | Know which guides are canonical, which evidence refreshes them, and which owner updates each guide. |

## Scope In

- Canonical troubleshooting taxonomy with symptom, likely owner, safe first action, evidence to
  collect, and escalation threshold.
- Guide families for local setup, `hobo` CLI, manifest and closure-builder authoring, auth and
  policy denials, provider/catalog readiness, networking/connectivity, deploy/reconcile, and
  hosted-service incidents.
- Agent-readable runbook snippets that use mocked or fixture-derived boundaries instead of live
  provider credentials.
- Redaction rules for logs, tokens, tenant identifiers, customer data, provider account IDs, and
  generated artifacts before support handoff.
- M1-ready acceptance checklist for taxonomy records, symptom-to-owner fixtures, safe-action
  examples, redaction rules, and support handoff examples.

## Scope Out And Non-Goals

- Do not build support queues, ticket routing, SLA enforcement, on-call scheduling, or escalation
  tooling.
- Do not implement runtime remediation, provider repair, control-plane behavior, CLI behavior,
  auth flows, or networking changes.
- Do not publish launch marketing pages, screenshots, videos, or public incident statements.
- Do not use live customer data, provider credentials, production logs, or unredacted tenant
  evidence.
- Do not create downstream M1-M4 implementation issues before this M0 scope record is accepted.
- Do not replace product error messages or CLI diagnostics.
- Do not certify production support readiness from docs fixtures alone.
- Do not define final docs portal IA, search, analytics, or publishing workflow.
- Do not own incident communications, public status-page updates, or support SLA policy.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Troubleshooting Guides define diagnostic contracts and evidence handoffs only; support systems, hosted operations, incident tooling, and product remediation stay in their owning projects. |
| UX | Guide UX covers symptom grouping, state labels, evidence checklists, and safe next actions, not final docs portal screens or in-product UI. |
| Security | Guides must fail closed on static secrets, provider credentials, customer data, unredacted logs, and policy-bypass instructions; every guide names redaction and live-versus-fixture boundaries. |
| Support | Support handoff records symptom, likely owner, severity, safe next action, evidence source, and escalation threshold; queues, SLAs, and staffing remain separate. |

## Authoritative Dependencies

- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines CLI, local-dev,
  dashboard, and inspection surfaces whose failures troubleshooting guides classify.
- [walkthrough.md](./walkthrough.md) provides role journeys whose stuck states become guide entry
  points.
- [launch-support-escalation.md](./launch-support-escalation.md) defines launch support escalation
  matrix and gap routing consumed by guide handoffs.
- [support-sla-channels.md](./support-sla-channels.md) defines channel coverage and unsupported
  request routing that guides must not override.
- [incident-communications.md](./incident-communications.md) separates troubleshooting guidance
  from customer-safe incident communications.
- [public-status-page-incident-communication.md](./public-status-page-incident-communication.md)
  separates public component and incident-state publication from guide evidence collection.
- [ADR-0064](./adr/07-portability-extensibility.md#adr-0064) keeps business mechanics, marketing,
  and non-platform launch claims outside guide scope.

## Owning Initiative Dependencies

| Owner | Consumes from Troubleshooting Guides | Boundary |
|---|---|---|
| Troubleshooting Guides | Accepted taxonomy, guide families, safe-action fixtures, redaction rules, and follow-up gate. | This issue defines scope and acceptance; it does not build final guide content or support tooling. |
| Docs Portal | Canonical taxonomy and guide metadata can become portal navigation and search inputs. | Portal IA, search, publishing, analytics, and frontend remain outside Troubleshooting M0. |
| Support Workflow | Handoff fixture shape and unsupported-state routing. | Queues, assignment, SLA timers, and operator staffing remain in support workflow. |
| V1 Launch Support Desk & Escalation | Escalation thresholds, severity labels, and launch gap routing. | Launch desk process and escalation staffing remain outside guide scope. |
| Incident Communications | Customer-safe evidence boundaries and incident handoff triggers. | Public or customer incident statements remain in incident communications. |
| Public Status Page | Component failure categories and evidence needed before a status-page update. | Status components, maintenance notices, and publication cadence remain separate. |
| V1 Release Program & Cutline | Readiness dashboards can classify unresolved troubleshooting-guide gaps by owner and proof mode. | Go/no-go decisions, accepted risks, and release evidence aggregation stay in the cutline project. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Guide taxonomy | Docs maintainer | Design record | Each guide family has symptom, owner, safe first action, evidence, and escalation threshold. |
| Symptom-to-owner map | Platform engineer | Reference fixture | Local setup, CLI, auth, policy, provider, networking, deploy, and incident symptoms route to the right owner. |
| Safe-action fixtures | Support operator | Reference fixture | Guides distinguish safe retry, collect evidence, escalate, and stop states. |
| Agent-readable runbook snippets | Coding agent | Agent fixture | Agent-facing guidance includes deterministic checks, expected output shape, and refusal states. |
| Security redaction rules | Security reviewer | Redaction rule | Logs, tokens, tenant identifiers, provider account IDs, and customer data are redacted before handoff. |
| Support escalation handoff | Support operator | Support handoff | Escalation records include symptom, severity, owner, evidence source, and safe next action. |

## Follow-Up Gate

M1/M2/M3/M4 guide content, docs portal, support workflow, incident communication, and status-page
issues must wait until this M0 scope record is accepted. This branch records the gate and its
executable guard; it does not create follow-up implementation issues.
