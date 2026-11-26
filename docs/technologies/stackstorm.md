---
type: Technology Reference
title: "StackStorm (st2)"
description: "StackStorm (st2) is an open-source, event-driven automation platform — self-described as **\"IFTTT for Ops\"** — for auto-remediation, incident response, troubleshooting, and deploym"
tags: [hobo, technologies]
---

# StackStorm (st2)

> **Technology** · event-driven automation / runbook engine ("IFTTT for Ops"). Source: [StackStorm/st2 (GitHub)](https://github.com/StackStorm/st2) · [docs.stackstorm.com](https://docs.stackstorm.com/). Excerpts quoted for analysis (fair use).

## What it is
StackStorm (st2) is an open-source, event-driven automation platform — self-described as **"IFTTT for Ops"** — for auto-remediation, incident response, troubleshooting, and deployments, aimed at DevOps and SREs. It connects the things you already have (monitoring, ChatOps, CI/CD, clouds, config management) by reacting to events with rule-matched actions and multi-step workflows. The canonical loop is **sensor → trigger → rule → action/workflow**, all wrapped in a rules engine and a content-packaging system (packs). It ships a large ecosystem — 160+ integration packs with 6000+ pre-built actions on the [StackStorm Exchange](https://exchange.stackstorm.org).

It is the prototypical **runbook-automation engine**: codifying the "when X happens, do Y (with these checks and approvals)" operational knowledge that otherwise lives in wiki pages and tribal memory.

## Key elements / features
- **Sensors** — Python plugins that observe external systems (poll an API, consume a queue, host a webhook endpoint) and **emit triggers**. They are the inbound integration edge.
- **Triggers** — typed representations of an external event (a Sensu alert, a JIRA update, a webhook payload, a timer). Generic triggers (webhook, timer) exist alongside pack-defined ones.
- **Rules** — the **if-then** core: match a trigger (with criteria/filters on the payload), map payload fields onto action inputs, and dispatch to an action or workflow. Rules are the declarative glue between events and responses.
- **Actions** — outbound integration: generic actions (SSH, HTTP request), integrations (OpenStack, Docker, Kubernetes, cloud providers), or custom scripts/Python plugins consumed by adding a few lines of metadata.
- **Workflows (Orquesta)** — st2's native workflow engine. A YAML-based DSL defines task dependencies, conditional transitions (`when` clauses), branching, retries, and context/data passing between steps — orchestrating multi-step responses rather than single actions. (Earlier engines: ActionChain, Mistral.)
- **Packs** — the **unit of content deployment**: a versioned bundle grouping integrations (sensors/triggers/actions) and automations (rules/workflows), shared via the Exchange.
- **ChatOps** — first-class chat integration (Hubot/Slack/etc.): invoke actions, query execution history, and **approve workflow steps** directly from chat.
- **Inquiries / approval gates** — the `core.ask` action **pauses a workflow** for human input/approval; `users`/`roles` parameters scope who may respond, so gated human-in-the-loop steps live inside the workflow itself ([Inquiries docs](https://docs.stackstorm.com/inquiries.html)).
- **RBAC** — role-based access control over actions, packs, executions, and even **key-value datastore** entries; execute-on-a-workflow can imply respond-on-its-inquiries ([RBAC docs](https://docs.stackstorm.com/rbac.html)).
- **Auditing & history** — every execution is recorded and queryable (full execution history), with audit log messages (e.g. on datastore-key decryption) for compliance.
- **Key-value datastore** — a built-in store (with encryption) for sharing config/state across sensors, rules, and workflows.

## Relevance to HoBo
StackStorm is the **canonical OSS analog of HoBo's Pipelines + rule-based automation** ([Plan 25](../design/platform-engineering.md#plan-25)). The structural mapping is almost one-to-one, which makes st2 a useful reference design — and a candidate optional provider — for the automation surface HoBo describes:

| StackStorm | HoBo ([Plan 25](../design/platform-engineering.md#plan-25)) |
|---|---|
| Sensor → Trigger | Pipeline **triggers**: artifact / deploy-request / schedule-cron / API-MCP |
| Rule (if-then, match criteria) | Pipeline **rules** (e.g. *"new component from `main` → deploy `staging`"*; *"tag `v*` → open a prod Delta requiring approval"*) |
| Action / Orquesta workflow | Pipeline **steps/jobs** (ordered via `needs` or parallel; tests, health-waits, external CI, notify) |
| Inquiry / `core.ask` approval | **Approval gate** = a `createHook` resolved in the dashboard ([Plan 6](../design/ai-native-agent-auth.md#plan-06)) |
| Execution history / audit log | **Every trigger/step/gate is an event** (`pipeline.Triggered`/`pipeline.StepCompleted`/`pipeline.GateApproved`, [Plan 11](../design/data-plane.md#plan-11)) — replayable, auditable |
| Packs (versioned content) | Resource Packs / policy packs ([Plan 25](../design/platform-engineering.md#plan-25)/[Plan 29](../design/contracts-policy-flags.md#plan-29)) — versioned, signed, distributable |

Where HoBo **diverges by design**:
- **Event-sourced, not just logged.** StackStorm records execution history; HoBo makes the event log the *source of truth* ([Plan 11](../design/data-plane.md#plan-11)), so a pipeline run is replayable and time-travelable, not merely auditable after the fact.
- **Policy-gated, not RBAC-only.** HoBo's gates compose into one **policy decision model** with rich effects and **obligations** ("allow but require canary") ([Plan 29](../design/contracts-policy-flags.md#plan-29)) — richer than st2's allow/deny RBAC plus inline inquiries.
- **Agent-drivable & MCP-native.** An `API/MCP` trigger lets agents drive pipelines first-class ([Plan 6](../design/ai-native-agent-auth.md#plan-06)/[Plan 7](../design/developer-experience.md#plan-07)), not just chat operators via ChatOps.
- **Typed-TS authoring option.** HoBo weighs typed-TS `definePipeline(...)` vs YAML ([Plan 25](../design/platform-engineering.md#plan-25) iteration hooks), where st2 standardizes on YAML/Orquesta.
- **Built atop gated deployment sagas.** HoBo Pipelines sit *above* the canary/blue-green/auto-rollback saga machinery ([Plan 5](../design/reliability-observability-cost.md#plan-05)) and the immutable-Set promotion model ([Plan 25](../design/platform-engineering.md#plan-25)); st2 orchestrates arbitrary actions but has no built-in deployment-Set/promotion semantics.

**Bet:** consistent with HoBo's "engines behind a WIT port" stance, **StackStorm could be an optional automation provider** behind the Pipelines surface (an adapter that runs Orquesta workflows as pipeline steps, or imports st2 packs as actions), while HoBo's native, event-sourced + policy-gated + agent-drivable model remains the default. Its 6000-action Exchange is the kind of ready-made integration breadth a provider seam can borrow without baking st2 into the core. See also the runbook/promotion pattern: [`../patterns/gitops-runbook-promotion.md`](../patterns/gitops-runbook-promotion.md).

## Sources
- [StackStorm/st2 — GitHub](https://github.com/StackStorm/st2)
- [Sensors and Triggers — StackStorm docs](https://docs.stackstorm.com/sensors.html)
- [Inquiries (workflow approval) — StackStorm docs](https://docs.stackstorm.com/inquiries.html)
- [Role Based Access Control — StackStorm docs](https://docs.stackstorm.com/rbac.html)
- [StackStorm Exchange (packs)](https://exchange.stackstorm.org)
- [StackStorm: Building Event-Driven Automation with Rules, Sensors, and Workflows — Starlog](https://starlog.is/articles/ai-dev-tools/stackstorm-st2/)
