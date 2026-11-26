---
layout: ../../layouts/Docs.astro
title: Event families
description: "Canonical event-family prefixes: contract, policy, gatekeeper, resilience, actor, crew, deployment, broker, meter, and domain facts."
---

# Event families

Event names use **`family.PastTenseFact`** shape. The design suite keeps a **canonical inventory**; new families must be cataloged before inventing backticked names in design or site prose.

## Envelope (conceptual)

Every fact rides a shared envelope family of fields:

| Field | Role |
|---|---|
| `id` | ULID — global causal-ish order |
| `seq` | Per-stream total order |
| `type` | `family.PastTenseFact` |
| `stream` / aggregate id | Ownership boundary |
| `causationId` / `correlationId` | Why / which workflow |
| `tenant` (+ project/env as applicable) | Isolation claims |
| `meta.idempotencyKey` | Exactly-once *effects* over at-least-once delivery |
| `position` | When read from DurableEventStore — store-local |

## Families you will hit often

| Family | Examples | Notes |
|---|---|---|
| `compat.*` | `GatePassed`, `GateFailed` | can-deploy outcomes |
| `contract.*` | `Observed`, `Verified`, `EffectDeclared`, `EffectInvoked` | Contract IR lifecycle |
| `policy.*` | `Decided`, `ObligationCreated`, `ObligationSatisfied` | **Always** decide, even allows |
| `gatekeeper.*` | `Decided` | Composed gate result |
| `resilience.*` | `Attempt`, `Terminal` | Secondary resiliency layer |
| `actor.*` | `Activated`, `StateAppended`, `Passivated` | Actor host lifecycle |
| `crew.*` | `AgentDispatched`, `ActionProposed`, `ActionApplied`, `HandoffRequested` | Thin roster — no per-operator silos |
| `incident.*` | Opened → … → Resolved / PostmortemFiled | SRE loop |
| `run.*` | `Started`, `StepCompleted` | Workflows / generation runs |
| `deployment.*` | Planned / Applied / Deployed / Failed / RolledBack | Control plane |
| `broker.*` | `Resolved`, `Rejected` | Conductor placement |
| `resource.*` | Provisioned / Failed / DriftDetected | ResourceActors |
| `token.*` / `identity.*` | Issued / Rotated / Accessed | Refs only for secrets |
| `config.*` / `secret.*` | `Resolved`, `Accessed` | Refs only |
| `meter.*` | `UsageRecorded` | Showback facts |
| `guardrail.*` | `Blocked` | AI safety |
| `trail.*` | Plan/run/cutover facts | Continuous migration recipes |
| `station.*` | Station/Rail lifecycle | Control-plane isolation |
| `replay.*` | `Started` / `ChunkIngested` / `Ended` / `Accessed` / … | Session Replay lifecycle (not event-log replay) |

Domain apps add **their own** families under app namespaces — do not overload `crew.*` or `deployment.*` for business cart events.

## Sandbox lanes

Boundary virtualization tags envelope **lane** metadata. Baseline contract promotion **ignores** sandbox-lane observations by default so experiments cannot poison production contracts or training trajectories.

## Rules

1. Past tense only — commands are not events.
2. Inspection and audit are **replay of the log**, not process memory.
3. Poison bodies → `*.Quarantined` so folds skip deterministically.
4. Crew roster facts stay on thin `crew.*` — operator-specific detail is payload, not family explosion.
5. Streamer frames are **not** automatically domain events.

## Related

[Architecture](/HoBo/architecture/) · [Data plane](/HoBo/architecture/data-plane/) · [Crew shared model](/HoBo/operations/shared-model/) · [EventStore](/HoBo/reference/eventstore/)
