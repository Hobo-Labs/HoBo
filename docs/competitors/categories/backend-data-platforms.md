---
type: Competitive Reference
title: "Backend & Data Application Platforms — category index"
description: "Category index: Integrated BaaS/data platforms collapsing provisioning, functions, auth, storage, realtime bindings, and application runtime."
tags: [hobo, competitors, category]
---

# Backend & Data Application Platforms

> Category index. Full research lives in each canonical capture — see [`../metadata-contract.md`](../metadata-contract.md) for why this page carries rows, not research.

## Category boundary

Integrated BaaS/data platforms collapsing provisioning, functions, auth, storage, realtime bindings, and application runtime.

## Why HoBo competes here

They win on data DX and can absorb the whole backend. HoBo consumes most of them as provider targets, but their authoring ergonomics set expectations HoBo inherits.

## Competitors (5)

| Competitor | Role in this category | Directness | Contested HoBo surface | Competitor advantage | HoBo distinction | Posture | Priority |
| ---------- | --------------------- | ---------- | ---------------------- | -------------------- | ---------------- | ------- | -------- |
| [**Convex**](../convex.md) *(primary)* | reactive TypeScript backend-as-a-service — source of the live-query gap and a possible provider target | adjacent | `typed-contracts`, `wiring`, `runtime-portability` | Reactive end-to-end live queries with automatic invalidation — a genuinely better data DX. | HoBo's CQRS/materialized-view model is provider-portable and event-sourced; the reactive gap is tracked, not denied. | borrow, provider-target | P1 |
| [**InsForge**](../insforge.md) *(primary)* | agent-native backend-as-a-service — agent-ops benchmark and possible provider target | adjacent | `agent-surface`, `typed-contracts` | Agent-native BaaS with a coherent MCP-shaped surface already shipped. | HoBo exposes agent surfaces through policy-gated contracts across any provider, not one hosted backend. | benchmark, provider-target | P2 |
| [**Supabase**](../supabase.md) *(primary)* | open-source Postgres BaaS — adjacent platform and possible provider target | adjacent | `typed-contracts`, `identity-secrets` | Best-in-class open Postgres platform with auth, realtime and storage. | HoBo consumes Supabase as a provider target behind data/auth ports instead of being one backend. | provider-target, benchmark | P2 |
| [**AWS Amplify**](../aws-amplify.md) | Gen-2 code-first TypeScript fullstack backend on AWS CDK — IfC-in-TS analog, AWS-only | overlapping | `authoring`, `typed-contracts`, `wiring` | Deeply integrated AWS backend generation with strong typed client codegen. | HoBo refuses single-cloud lock-in: the same manifest scores and deploys across providers. | benchmark | P3 |
| [**Wasp**](../wasp.md) | Rails-like full-stack framework driven by a declarative .wasp spec — App-Kit inspiration and packaging path | adjacent | `authoring`, `app-graph` | Very fast full-stack scaffolding from one declarative spec. | HoBo's spec drives provider-portable deployment, not a fixed React/Node/Prisma stack. | borrow, benchmark | P3 |

## Navigation

- [All categories](index.md) · [corpus index](../index.md) · [cross-category matrix](../matrix.md) · [gap analysis](../gap-analysis.md)
