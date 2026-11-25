---
type: Reference
title: "Tutorials & Walkthroughs Scope and Acceptance"
description: "Source issue: HOBO-436."
tags: [hobo, design]
---

# Tutorials & Walkthroughs Scope and Acceptance

Source issue: HOBO-436.

Executable proof lives in
[`src/draft/exp-proofs/dx/tutorials-walkthroughs-scope-acceptance`](../../src/draft/exp-proofs/dx/tutorials-walkthroughs-scope-acceptance/README.md).
Branch evidence is summarized in
[`proofs/hobo-436-tutorials-walkthroughs-scope`](./proofs/hobo-436-tutorials-walkthroughs-scope/index.md).

## M0 Acceptance Record

Tutorials & Walkthroughs exists to turn the design suite into durable learning paths without hiding
implementation, docs-portal, marketing, support, or live-service work inside tutorial scope. This
M0 record defines what later M1 design and contract issues must prove before any downstream tutorial
implementation can claim the v1 learning path is ready.

## User And Business Goal

HoBo needs launch-safe tutorials that help humans and coding agents follow the platform story from
first run through role-specific operation. The scope must make each tutorial path explicit about its
persona, entry condition, command path, proof mode, expected evidence, known limitations, and owner.
Tutorials can teach the workflow, but they cannot become a substitute for the product surfaces,
example apps, docs portal, support workflow, or launch marketing assets they reference.

## Primary Personas

| Persona | Need |
|---|---|
| First-time app developer | Follow a short path from concept to local run, plan, deploy attempt, recovery, and inspection evidence. |
| Coding agent | Use deterministic tutorial steps, command transcripts, and fixtures without private local knowledge. |
| Platform engineer evaluator | See where provider defaults, catalogs, policy gates, and self-host setup enter the walkthrough. |
| Docs maintainer | Know which tutorials are canonical, what evidence refreshes them, and which owners maintain each path. |
| Support operator | Map stuck tutorial states to safe next actions, owners, and support handoff records. |

## Scope In

- Canonical tutorial map with persona, entry condition, command path, expected evidence, and owner
  per tutorial.
- Role walkthrough paths for app developer, platform engineer, GitOps, SecOps, DevOps, and SRE that
  consume the accepted role walkthrough rather than replacing it.
- Agent-readable step fixtures and command transcripts for tutorial paths that can be replayed
  without live provider credentials.
- Proof-mode rules that distinguish design record, contract test, reference fixture, agent fixture,
  accessibility note, and support handoff evidence.
- M1-ready acceptance checklist for tutorial map, persona scenarios, transcripts, agent fixtures,
  accessibility/localization notes, and support handoff fixtures.

## Scope Out And Non-Goals

- Do not build the production docs portal, tutorial frontend, or marketing site.
- Do not author final launch marketing copy, demo videos, screenshots, or public campaign pages.
- Do not provision live cloud resources, use provider credentials, or capture real customer data.
- Do not change CLI verbs, SDK behavior, provider mappings, auth flows, billing, or support SLA
  implementation.
- Do not create downstream M1-M4 implementation issues before this M0 scope record is accepted.
- Do not replace the existing role walkthrough or worked example.
- Do not build example applications or the launch demo golden path.
- Do not claim production readiness from reference fixtures alone.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Tutorials define learning and proof contracts only; docs portal hosting, search, analytics, and CMS services remain in their owner projects. |
| UX | Tutorial UX covers journey shape, step states, evidence, and accessibility notes, not final screens, navigation, or marketing polish. |
| Security | Tutorials cannot embed static keys, provider credentials, customer data, or policy bypasses; every claim names its proof mode and live-versus-simulated boundary. |
| Support | Support handoff records stuck step, likely owner, safe next action, and evidence source; support queues, SLAs, and escalation process remain separate. |

## Authoritative Dependencies

- [walkthrough.md](./walkthrough.md) defines the six-role ideal-state journey that tutorials must
  consume and make executable.
- [worked-example.md#plan-19](./worked-example.md#plan-19) keeps `snapshop` as the compact
  end-to-end example that tutorial paths can reference.
- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines CLI, dashboard,
  local-dev, and inspection surfaces that tutorial steps exercise.
- [example-apps.md](./example-apps.md) supplies example-app proof modes and fixtures that tutorials
  can reuse.
- [workspace-onboarding-ux.md](./workspace-onboarding-ux.md) defines first-run activation stages and
  stalled-state handoff inputs consumed by tutorials.
- [ADR-0064](./adr/07-portability-extensibility.md#adr-0064) keeps business mechanics,
  monetization, and marketing surfaces outside tutorial scope.

## Owning Initiative Dependencies

| Owner | Consumes from Tutorials & Walkthroughs | Boundary |
|---|---|---|
| Tutorials & Walkthroughs | Accepted tutorial map, proof-mode rules, persona scenarios, transcripts, and follow-up gate. | This issue defines scope and acceptance; it does not build the docs portal or final tutorials. |
| Docs Portal | Tutorial map and evidence states can become portal information architecture inputs. | Portal IA, frontend, search, analytics, and publishing remain outside Tutorials M0. |
| Example Apps | Tutorial paths can reuse accepted example fixtures and proof modes. | Tutorials consume examples; they do not build or certify example applications. |
| Workspace & Onboarding UX | First-run states and recovery categories can feed tutorial step status and blocked-state wording. | Activation telemetry, product UX, and onboarding implementation remain in onboarding. |
| Customer Onboarding | Pilot onboarding scripts can reuse tutorial success/failure categories and comparable transcripts. | Customer scripts, cohort feedback, and success process stay in Customer Onboarding. |
| Support Workflow | Tutorial stuck states route to safe next action, owner, and evidence source. | Support queues, SLA targets, escalation, and tooling remain in Support Workflow. |
| V1 Launch Site, Messaging & Demo Assets | Launch claims and demos can reference accepted tutorial proof modes and known limitations. | Marketing copy, demo videos, screenshots, and public campaign pages remain outside Tutorials M0. |
| V1 Release Program & Cutline | Readiness dashboards can classify tutorial gaps by blocker category and proof mode. | Go/no-go, accepted risks, release notes, and launch decisions stay in the cutline project. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Tutorial map | Docs maintainer | Design record | Each canonical tutorial has persona, entry condition, command path, expected evidence, and owner. |
| Persona walkthrough scenarios | Docs maintainer | Reference fixture | App developer, platform engineer, GitOps, SecOps, DevOps, and SRE paths can be exercised consistently. |
| Command transcripts | Coding agent | Reference fixture | CLI/MCP tutorial steps are reproducible without private local setup or provider credentials. |
| Agent-run fixtures | Coding agent | Agent fixture | Agent-readable tutorial steps include fixtures, expected outputs, and refusal states. |
| Accessibility and localization notes | Docs maintainer | Accessibility note | Tutorial content identifies keyboard/screen-reader, language, and non-visual evidence obligations before UI work. |
| Support handoff fixtures | Support operator | Support handoff | Blocked tutorial states carry safe next action, owner, and evidence source for support. |

## Follow-Up Gate

M1/M2/M3/M4 design, docs portal, tutorial implementation, and launch asset issues must wait until
this M0 scope record is accepted. This branch records the gate and its executable guard; it does not
create follow-up implementation issues.
